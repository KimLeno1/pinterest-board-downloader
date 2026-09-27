function resolve_url(base, value) {
    return new URL(value, base).toString();
}

function parse_attribute_list(line) {
    const attrs = {};
    const match = line.match(/^[^:]+:(.*)$/);
    if (!match) return attrs;

    const value = match[1];
    const regex = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let item;
    while ((item = regex.exec(value))) {
        attrs[item[1]] = item[2].replace(/^"|"$/g, '');
    }
    return attrs;
}

function parse_master_playlist(text, base_url) {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const variants = [];

    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
        const attrs = parse_attribute_list(lines[i]);
        const uri = lines[i + 1] && !lines[i + 1].startsWith('#') ? lines[i + 1] : null;
        if (!uri) continue;

        variants.push({
            url: resolve_url(base_url, uri),
            bandwidth: Number(attrs.BANDWIDTH || 0),
            width: Number((attrs.RESOLUTION || '0x0').split('x')[0] || 0),
            height: Number((attrs.RESOLUTION || '0x0').split('x')[1] || 0)
        });
    }

    return variants.sort((a, b) =>
        (b.bandwidth - a.bandwidth) ||
        (b.width * b.height - a.width * a.height)
    );
}

function parse_media_playlist(text, base_url) {
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

    if (lines.some(line => line.startsWith('#EXT-X-KEY:'))) {
        throw new Error('Encrypted HLS video is not supported by the local downloader yet.');
    }

    let init_url = null;
    const segments = [];

    for (const line of lines) {
        if (line.startsWith('#EXT-X-MAP:')) {
            const attrs = parse_attribute_list(line);
            if (attrs.URI) init_url = resolve_url(base_url, attrs.URI);
        } else if (!line.startsWith('#')) {
            segments.push(resolve_url(base_url, line));
        }
    }

    if (!segments.length) {
        throw new Error('The HLS playlist contained no video segments.');
    }

    return { init_url, segments };
}

async function fetch_bytes(url, referrer = '') {
    const response = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
        referrer: referrer || undefined,
        referrerPolicy: 'strict-origin-when-cross-origin'
    });
    if (!response.ok) {
        throw new Error(`Media request failed (${response.status})`);
    }
    return new Uint8Array(await response.arrayBuffer());
}

async function download_hls(url, filename, referrer = '') {
    const master_response = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
        referrer: referrer || undefined,
        referrerPolicy: 'strict-origin-when-cross-origin'
    });
    if (!master_response.ok) throw new Error(`HLS playlist request failed (${master_response.status})`);

    const master_text = await master_response.text();
    const variants = parse_master_playlist(master_text, url);

    let playlist_url = url;
    if (variants.length) playlist_url = variants[0].url;

    const playlist_response = variants.length
        ? await fetch(playlist_url, { credentials: 'include', cache: 'no-store', redirect: 'follow', referrer: referrer || undefined, referrerPolicy: 'strict-origin-when-cross-origin' })
        : master_response;

    if (!playlist_response.ok) {
        throw new Error(`Video playlist request failed (${playlist_response.status})`);
    }

    const playlist_text = variants.length ? await playlist_response.text() : master_text;
    const playlist = parse_media_playlist(playlist_text, playlist_url);

    const chunks = [];

    if (playlist.init_url) {
        chunks.push(await fetch_bytes(playlist.init_url, referrer));
    }

    // Sequential fetching keeps peak memory manageable and is more polite to
    // Pinterest's CDN than firing hundreds of simultaneous requests.
    for (const segment_url of playlist.segments) {
        chunks.push(await fetch_bytes(segment_url, referrer));
    }

    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    if (!total) throw new Error('HLS stream produced no bytes.');

    const is_fragmented_mp4 = !!playlist.init_url;
    const blob = new Blob(chunks, {
        type: is_fragmented_mp4 ? 'video/mp4' : 'video/mp2t'
    });

    const output_filename = is_fragmented_mp4
        ? filename.replace(/\.(?:mp4|m3u8|ts)$/i, '') + '.mp4'
        : filename.replace(/\.(?:mp4|m3u8|ts)$/i, '') + '.ts';

    const object_url = URL.createObjectURL(blob);
    try {
        const download_id = await chrome.downloads.download({
            url: object_url,
            filename: output_filename,
            conflictAction: 'overwrite',
            saveAs: false
        });
        return download_id;
    } finally {
        setTimeout(() => URL.revokeObjectURL(object_url), 60_000);
    }
}

async function download_blob_url(blob, filename) {
    if (!(blob instanceof Blob) || blob.size === 0) throw new Error('Pinterest returned an empty media file.');
    const object_url = URL.createObjectURL(blob);
    try {
        return await chrome.downloads.download({
            url: object_url,
            filename,
            conflictAction: 'overwrite',
            saveAs: false
        });
    } finally {
        // Keep the object URL alive long enough for Chrome's downloads manager to read it.
        setTimeout(() => URL.revokeObjectURL(object_url), 5 * 60_000);
    }
}

async function download_direct_media(url, filename, referrer = '') {
    const response = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
        referrer: referrer || undefined,
        referrerPolicy: 'strict-origin-when-cross-origin'
    });
    if (!response.ok) throw new Error(`Media request failed (${response.status})`);
    const content_type = (response.headers.get('content-type') || '').toLowerCase();
    if (content_type.includes('text/html')) {
        throw new Error('Pinterest returned an HTML page instead of media (possible login/challenge response).');
    }
    const blob = await response.blob();
    return download_blob_url(blob, filename);
}

chrome.runtime.onMessage.addListener((message, sender, send_response) => {
    if (message?.type !== 'download-hls-in-offscreen' && message?.type !== 'download-media-in-offscreen') return false;

    (async () => {
        try {
            const filename = String(message.filename || 'pinterest_media');
            const referrer = String(message.referrer || '');
            let download_id;

            if (message.type === 'download-media-in-offscreen') {
                download_id = await download_direct_media(String(message.url || ''), filename, referrer);
            } else {
                download_id = await download_hls(String(message.url || ''), filename, referrer);
            }

            send_response({ accepted: true, download_id });
        } catch (error) {
            send_response({ accepted: false, error: error?.message || String(error) });
        }
    })();

    return true;
});
