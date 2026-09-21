// Download jobs: whole files, and segmented streams assembled into one Blob. Where the
// requests come from (and therefore whose cookies, origin and headers they carry) is up to
// the caller's `fetchImpl` / `fetchBytes`.
import { parseMpd, repExt } from './dash.js';
import { ivFor, parsePlaylist } from './hls.js';

const CONCURRENCY = 6;

// `fetchBytes(url, byteRange)` with retries on top of `fetchImpl(url, { headers, signal })`,
// which decides how requests are made (by default plain fetch).
export function makeFetchBytes({ signal, retries = 3, fetchImpl = (url, init) => fetch(url, init) } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return async (url, byteRange) => {
    for (let attempt = 1; ; attempt++) {
      try {
        const headers = {};
        if (byteRange) headers.Range = `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}`;
        const res = await fetchImpl(url, { headers, signal });
        if (!res.ok) throw new Error(`下載失敗（HTTP ${res.status}）`);
        return new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        if (signal?.aborted || attempt >= retries) throw e;
        await sleep(500 * attempt);
      }
    }
  };
}

// Pause switch shared by a job's workers. While paused, `wait()` blocks and
// `pauseSignal` is aborted, so in-flight requests can be dropped and resumed later.
export function makeGate() {
  let paused = false;
  let waiters = [];
  let pauseCtl = new AbortController();
  return {
    get paused() {
      return paused;
    },
    get pauseSignal() {
      return pauseCtl.signal;
    },
    pause() {
      if (paused) return;
      paused = true;
      pauseCtl.abort();
    },
    resume() {
      if (!paused) return;
      paused = false;
      pauseCtl = new AbortController();
      waiters.splice(0).forEach((r) => r());
    },
    wait() {
      return paused ? new Promise((r) => waiters.push(r)) : Promise.resolve();
    },
  };
}

// Downloads one whole file as a Blob, reporting `onProgress({ done, total, bytes })` in bytes
// (total is 0 when the server does not say). Pausing drops the connection; resuming asks for
// the rest with a Range request, or starts over if the server ignores it.
export async function fetchFile(url, { fetchImpl = (u, init) => fetch(u, init), signal, onProgress = () => {}, gate }) {
  const chunks = [];
  let bytes = 0;
  let total = 0;
  let type = '';
  for (;;) {
    await gate?.wait();
    if (signal?.aborted) throw new Error('已取消');
    const signals = [signal, gate?.pauseSignal].filter(Boolean);
    try {
      const headers = bytes ? { Range: `bytes=${bytes}-` } : {};
      const res = await fetchImpl(url, { headers, signal: signals.length ? AbortSignal.any(signals) : undefined });
      if (!res.ok) throw new Error(`下載失敗（HTTP ${res.status}）`);
      if (bytes && res.status !== 206) {
        chunks.length = 0;
        bytes = 0;
      }
      if (!total) {
        const range = res.headers.get('content-range')?.match(/\/(\d+)\s*$/);
        total = range ? Number(range[1]) : Number(res.headers.get('content-length')) || 0;
      }
      type ||= res.headers.get('content-type') || '';
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        bytes += value.byteLength;
        onProgress({ done: bytes, total, bytes });
      }
      break;
    } catch (e) {
      if (gate?.paused && !signal?.aborted) {
        onProgress({ done: bytes, total, bytes });
        continue;
      }
      throw e;
    }
  }
  onProgress({ done: bytes, total: total || bytes, bytes });
  return new Blob(chunks, { type });
}

// Fetches `segs` ([{ url, byteRange }]) with a few parallel workers and returns their bytes
// in order, each passed through `transform(bytes, seg)` (e.g. decryption). A paused `gate`
// holds workers between segments; in-flight ones still land.
export async function fetchSegments(segs, { fetchBytes, signal, onProgress = () => {}, gate, transform }) {
  const parts = new Array(segs.length);
  let next = 0;
  let done = 0;
  let bytes = 0;
  const report = () => onProgress({ done, total: segs.length, bytes });

  const worker = async () => {
    for (;;) {
      await gate?.wait();
      if (next >= segs.length || signal?.aborted) return;
      const i = next++;
      let data = await fetchBytes(segs[i].url, segs[i].byteRange);
      if (transform) data = await transform(data, segs[i]);
      parts[i] = data;
      done++;
      bytes += data.byteLength;
      report();
    }
  };

  report();
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, segs.length) }, worker));
  if (signal?.aborted) throw new Error('已取消');
  return parts;
}

const parse = (bytes, url) => parsePlaylist(new TextDecoder().decode(bytes), url);

// Downloads one HLS stream. `beforeFetch(urls)` runs before new URLs are requested (e.g. to
// install header rules). Resolves to { blob, ext }.
export async function runHlsJob(
  url,
  { fetchBytes, signal, onProgress = () => {}, beforeFetch = async () => {}, gate },
) {
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

  const decrypt = async (data, seg) => {
    if (!seg.key) return data;
    const key = await loadKey(seg.key.url);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivFor(seg) }, key, data));
  };
  const parts = await fetchSegments(segs, { fetchBytes, signal, onProgress, gate, transform: decrypt });
  const init = pl.map ? [await fetchBytes(pl.map.url, pl.map.byteRange)] : [];

  // fMP4 streams (with an init map) concatenate into a playable MP4; the rest are MPEG-TS.
  const ext = pl.map ? 'mp4' : 'ts';
  return { blob: new Blob([...init, ...parts], { type: pl.map ? 'video/mp4' : 'video/mp2t' }), ext };
}

// Downloads one representation of a DASH stream: its init segment followed by its media
// segments, which concatenate into a playable fragmented MP4 / WebM. Resolves to { blob, ext }.
export async function runDashJob(
  url,
  repId,
  { fetchBytes, signal, onProgress = () => {}, beforeFetch = async () => {}, gate },
) {
  await beforeFetch([url]);
  const mpd = parseMpd(new TextDecoder().decode(await fetchBytes(url, null)), url);
  if (mpd.live) throw new Error('直播串流目前不支援下載');
  const rep = mpd.reps.find((r) => r.id === repId);
  if (!rep) throw new Error('找不到這個畫質');
  if (rep.protected) throw new Error('此串流受 DRM 保護，無法下載');
  const { init, segments } = mpd.segmentsFor(repId);
  if (!segments.length) throw new Error('清單沒有任何片段');
  await beforeFetch([...(init ? [init.url] : []), ...segments.map((s) => s.url)]);
  const parts = await fetchSegments(segments, { fetchBytes, signal, onProgress, gate });
  const head = init ? [await fetchBytes(init.url, init.byteRange)] : [];
  return { blob: new Blob([...head, ...parts], { type: rep.mimeType }), ext: repExt(rep) };
}
