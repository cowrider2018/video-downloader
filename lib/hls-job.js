// Downloads one HLS stream into a single Blob. Where the requests come from (and therefore
// whose cookies, origin and headers they carry) is up to the caller's `fetchBytes`.
import { ivFor, parsePlaylist } from './hls.js';

const CONCURRENCY = 6;

// fetch-based `fetchBytes(url, byteRange)` with retries; `init` is merged into every request.
export function makeFetchBytes({ signal, init = {}, retries = 3 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return async (url, byteRange) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const headers = { ...init.headers };
        if (byteRange) headers.Range = `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`;
        const res = await fetch(url, { ...init, headers, signal });
        if (!res.ok) throw new Error(`下載失敗（HTTP ${res.status}）`);
        return new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        if (signal?.aborted || attempt >= retries) throw e;
        await sleep(500 * attempt);
      }
    }
  };
}

const parse = (bytes, url) => parsePlaylist(new TextDecoder().decode(bytes), url);

// `beforeFetch(urls)` runs before new URLs are requested (e.g. to install header rules).
// Resolves to { blob, ext }.
export async function runHlsJob(url, { fetchBytes, signal, onProgress = () => {}, beforeFetch = async () => {} }) {
  await beforeFetch([url]);
  let pl = parse(await fetchBytes(url, null), url);
  if (pl.type === 'master') {
    url = pl.variants[0].url;
    await beforeFetch([url]);
    pl = parse(await fetchBytes(url, null), url);
  }
  if (!pl.endList) throw new Error('直播串流目前不支援下載');
  if (!pl.segments.length) throw new Error('播放清單沒有任何片段');
  if (pl.segments.some((s) => s.key && (s.key.method !== 'AES-128' || !s.key.url))) {
    throw new Error('此串流受 DRM 或 SAMPLE-AES 保護，無法下載');
  }
  const segs = pl.segments;
  if (segs.some((s) => s.key) && !globalThis.crypto?.subtle) {
    throw new Error('此頁面不是安全連線（https），無法解密');
  }
  await beforeFetch([
    ...segs.map((s) => s.url),
    ...segs.filter((s) => s.key).map((s) => s.key.url),
    ...(pl.map ? [pl.map.url] : []),
  ]);

  const keys = new Map(); // key URL -> Promise<CryptoKey>
  const loadKey = (keyUrl) => {
    if (!keys.has(keyUrl)) {
      keys.set(
        keyUrl,
        fetchBytes(keyUrl, null).then((raw) => crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt'])),
      );
    }
    return keys.get(keyUrl);
  };

  const parts = new Array(segs.length);
  let next = 0;
  let done = 0;
  let bytes = 0;
  const report = () => onProgress({ done, total: segs.length, bytes });

  const worker = async () => {
    while (next < segs.length && !signal?.aborted) {
      const i = next++;
      const seg = segs[i];
      let data = await fetchBytes(seg.url, seg.byteRange);
      if (seg.key) {
        const key = await loadKey(seg.key.url);
        data = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(seg) }, key, data));
      }
      parts[i] = data;
      done++;
      bytes += data.byteLength;
      report();
    }
  };

  report();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, segs.length) }, worker));
  if (signal?.aborted) throw new Error('已取消');
  const init = pl.map ? [await fetchBytes(pl.map.url, pl.map.byteRange)] : [];

  // fMP4 streams (with an init map) concatenate into a playable MP4; the rest are MPEG-TS.
  const ext = pl.map ? 'mp4' : 'ts';
  return { blob: new Blob([...init, ...parts], { type: pl.map ? 'video/mp4' : 'video/mp2t' }), ext };
}
