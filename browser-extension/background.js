let offscreen_creation_promise = null;

function is_pinterest_url(url) {
    try {
        const parsed = new URL(String(url || ''));
        return /^https?:$/i.test(parsed.protocol) && /(^|\.)pinterest\.[a-z.]+$/i.test(parsed.hostname);
    } catch {
        return false;
    }
}

function progressive_video_fallbacks(url) {
    if (typeof url !== 'string' || !url) return [];
    const candidates = [];
    const add = value => {
        if (value && value !== url && !candidates.includes(value)) candidates.push(value);
    };
    for (const quality of ['720p', '540p', '480p', '360p']) {
        add(url.replace(/\/hls\//i, `/${quality}/`).replace(/\.m3u8(?:[?#].*)?$/i, '.mp4'));
    }
    return candidates;
}

async function ensure_offscreen_document() {
    if (!chrome.offscreen?.createDocument) {
        throw new Error('Chrome offscreen documents are not available in this browser version.');
    }

    const contexts = await chrome.runtime.getContexts?.({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts?.some(context => context.documentUrl?.endsWith('offscreen.html'))) return;

    if (!offscreen_creation_promise) {
        offscreen_creation_promise = chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['BLOBS'],
            justification: 'Fetch Pinterest media and turn it into browser-downloadable blobs when a direct download is interrupted.'
        }).finally(() => {
            offscreen_creation_promise = null;
        });
    }
    await offscreen_creation_promise;
}

function wait_for_download(download_id, timeout_ms = 15000) {
    return new Promise(async (resolve) => {
        let settled = false;
        let timeout = null;

        const on_changed = async delta => {
            if (delta.id !== download_id || !delta.state?.current) return;
            if (delta.state.current === 'complete') {
                finish({ state: 'complete' });
            } else if (delta.state.current === 'interrupted') {
                try {
                    const [item] = await chrome.downloads.search({ id: download_id });
                    finish({ state: 'interrupted', error: item?.error || 'DOWNLOAD_INTERRUPTED' });
                } catch {
                    finish({ state: 'interrupted', error: 'DOWNLOAD_INTERRUPTED' });
                }
            }
        };

        const finish = result => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            chrome.downloads.onChanged?.removeListener?.(on_changed);
            resolve(result);
        };

        if (!chrome.downloads.onChanged?.addListener || !chrome.downloads.search) {
            return finish({ state: 'in_progress', pending: true });
        }

        // Start the timeout before registering the event listener so a very fast completion
        // cannot happen before the timeout handle exists.
        timeout = setTimeout(async () => {
            try {
                const [item] = await chrome.downloads.search({ id: download_id });
                if (item?.state === 'interrupted') {
                    finish({ state: 'interrupted', error: item.error || 'DOWNLOAD_INTERRUPTED' });
                } else if (item?.state === 'complete') {
                    finish({ state: 'complete' });
                } else {
                    finish({ state: item?.state || 'in_progress', pending: true });
                }
            } catch {
                finish({ state: 'in_progress', pending: true });
            }
        }, timeout_ms);

        chrome.downloads.onChanged.addListener(on_changed);

        try {
            const [item] = await chrome.downloads.search({ id: download_id });
            if (item?.state === 'complete') return finish({ state: 'complete' });
            if (item?.state === 'interrupted') return finish({ state: 'interrupted', error: item.error || 'DOWNLOAD_INTERRUPTED' });
        } catch {
        }
    });
}

async function direct_download(url, filename) {
    const download_id = await chrome.downloads.download({
        url,
        filename,
        conflictAction: 'overwrite',
        saveAs: false
    });

    if (!Number.isInteger(download_id)) {
        throw new Error('Chrome did not return a download ID.');
    }

    const state = await wait_for_download(download_id);
    if (state.state === 'interrupted') {
        const error = new Error(`Chrome download interrupted: ${state.error || 'unknown reason'}`);
        error.download_id = download_id;
        error.interrupted = true;
        throw error;
    }

    return { download_id, pending: !!state.pending };
}

async function offscreen_download(url, filename, referrer) {
    await ensure_offscreen_document();
    const response = await chrome.runtime.sendMessage({
        type: 'download-media-in-offscreen',
        url,
        filename,
        referrer: referrer || ''
    });
    if (!response?.accepted) {
        throw new Error(response?.error || 'Offscreen media downloader rejected the file.');
    }

    if (Number.isInteger(response.download_id)) {
        const state = await wait_for_download(response.download_id);
        if (state.state === 'interrupted') {
            throw new Error(`Offscreen download interrupted: ${state.error || 'unknown reason'}`);
        }
        return { download_id: response.download_id, fallback: true, pending: !!state.pending };
    }

    return { download_id: null, fallback: true, pending: true };
}

async function download_media(message) {
    const url = String(message.url || '');
    const filename = String(message.filename || 'pin_media');
    if (!url) throw new Error('No download URL was provided.');

    const is_hls = /\.m3u8(?:[?#]|$)/i.test(url);

    if (!is_hls) {
        const is_image = String(message.media_kind || '').toLowerCase() === 'image' || /(?:jpg|jpeg|png|webp|gif|avif)(?:[?#]|$)/i.test(url);

        // For Pinterest CDN images, fetching in the extension's offscreen context first lets
        // us preserve the Pin referrer and avoid Chrome Download Manager rejecting the CDN
        // request after it was initially accepted. Fall back to Chrome's native downloader
        // for large/unsupported responses.
        if (is_image && /pinimg\.com/i.test(url)) {
            try {
                return await offscreen_download(url, filename, message.referrer);
            } catch (offscreen_error) {
                try {
                    return await direct_download(url, filename);
                } catch (direct_error) {
                    throw new Error(`${offscreen_error?.message || 'Offscreen image download failed'}; direct fallback failed: ${direct_error?.message || direct_error}`);
                }
            }
        }

        try {
            // Fast path for videos/other media: Chrome handles redirects and large files.
            return await direct_download(url, filename);
        } catch (error) {
            try {
                return await offscreen_download(url, filename, message.referrer);
            } catch (fallback_error) {
                throw new Error(`${error?.message || 'Direct download failed'}; fallback failed: ${fallback_error?.message || fallback_error}`);
            }
        }
    }

    // Pinterest HLS master playlist: prefer its progressive MP4 siblings.
    for (const fallback_url of progressive_video_fallbacks(url)) {
        try {
            return await direct_download(fallback_url, filename);
        } catch {
            try {
                return await offscreen_download(fallback_url, filename, message.referrer);
            } catch {
            }
        }
    }

    await ensure_offscreen_document();
    const response = await chrome.runtime.sendMessage({
        type: 'download-hls-in-offscreen',
        url,
        filename,
        referrer: message.referrer || ''
    });
    if (!response?.accepted) throw new Error(response?.error || 'HLS downloader rejected the stream.');
    return { download_id: response.download_id ?? null, hls: true };
}

chrome.runtime.onMessage.addListener((message, sender, send_response) => {
    if (sender.id !== chrome.runtime.id || !message?.type) return false;

    if (message.type === 'download-pin') {
        (async () => {
            try {
                const result = await download_media(message);
                send_response({ accepted: true, ...result });
            } catch (error) {
                send_response({ accepted: false, error: error?.message || String(error) });
            }
        })();
        return true;
    }

    return false;
});

async function set_action_state_for_tab(tab_id, url) {
    if (!Number.isInteger(tab_id)) return;
    try {
        if (is_pinterest_url(url)) await chrome.action.enable(tab_id);
        else await chrome.action.enable(tab_id);
    } catch {
    }
}

async function handle_action_click(tab) {
    if (!tab?.id) return;
    try { await set_action_state_for_tab(tab.id, tab.url); } catch {}
    if (!is_pinterest_url(tab.url)) return;
    try {
        await chrome.tabs.sendMessage(tab.id, { type: 'toggle-ui' });
    } catch {
        // The declarative content script may not have been attached yet (for example,
        // immediately after a SPA navigation). Check for its launcher first so we do not
        // inject a second copy into an already-running content-script world.
        try {
            const [{ result: launcher_present }] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => !!document.getElementById('cc_enable_downloader')
            });
            if (!launcher_present) {
                await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['client.js'] });
            }
            setTimeout(() => chrome.tabs.sendMessage(tab.id, { type: 'toggle-ui' }).catch(() => {}), 150);
        } catch {
        }
    }
}

if (chrome.action?.onClicked) {
    chrome.action.onClicked.addListener(handle_action_click);
}

if (chrome.runtime.onInstalled) {
    chrome.runtime.onInstalled.addListener(() => {
        chrome.action?.setTitle?.({ title: 'Pinterest Board Downloader' }).catch?.(() => {});
    });
}

// Explicitly enable the toolbar action for every tab. Chrome actions are enabled by default,
// but doing this also repairs a previously-disabled per-tab state when an older build left the
// action greyed out. The icon remains harmless outside Pinterest; clicking it there does nothing.
if (chrome.tabs?.onUpdated) {
    chrome.tabs.onUpdated.addListener((tab_id, change_info, tab) => {
        const url = change_info?.url || tab?.url || '';
        set_action_state_for_tab(tab_id, url);
    });
}

if (chrome.tabs?.onActivated) {
    chrome.tabs.onActivated.addListener(async ({ tabId }) => {
        try {
            const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
            await set_action_state_for_tab(tabId, tab?.url || '');
        } catch {
        }
    });
}
