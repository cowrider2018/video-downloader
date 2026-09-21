// Runs HLS jobs: fetches every segment, decrypts AES-128, concatenates them into one Blob
// and hands its blob: URL back to the service worker, which cannot create blob URLs itself.
import { ivFor, parsePlaylist } from '../lib/hls.js';

const CONCURRENCY = 6;
const RETRIES = 3;

const running = new Map(); // job id -> { controller, cancelled, blobUrl }

const post = (msg) => chrome.runtime.sendMessage({ target: 'background', ...msg }).catch(() => {});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'hls-start') run(msg.job);
  if (msg.type === 'cancel') {
    const r = running.get(msg.id);
    if (r) {
      r.cancelled = true;
      r.controller.abort();
    }
  }
  if (msg.type === 'release') {
    const r = running.get(msg.id);
    if (r?.blobUrl) URL.revokeObjectURL(r.blobUrl);
    running.delete(msg.id);
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchBytes(url, byteRange, signal) {
  for (let attempt = 1; ; attempt++) {
    try {
      const headers = byteRange
        ? { Range: `bytes=${byteRange.offset}-${byteRange.offset + byteRange.length - 1}` }
        : {};
      const res = await fetch(url, { headers, signal, credentials: 'include' });
      if (!res.ok) throw new Error(`下載失敗（HTTP ${res.status}）`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (signal.aborted || attempt >= RETRIES) throw e;
      await sleep(500 * attempt);
    }
  }
}

async function fetchPlaylist(url, signal) {
  const bytes = await fetchBytes(url, null, signal);
  return parsePlaylist(new TextDecoder().decode(bytes), url);
}

async function run(job) {
  const state = { controller: new AbortController(), cancelled: false, blobUrl: null };
  running.set(job.id, state);
  const { signal } = state.controller;
  const hosts = new Set();

  // Many CDNs refuse segment requests without the page's Referer; the service worker
  // installs a header rule for every host this job touches.
  const allowHosts = async (urls) => {
    const before = hosts.size;
    for (const u of urls) hosts.add(new URL(u).hostname);
    if (hosts.size !== before) {
      await chrome.runtime.sendMessage({
        target: 'background',
        type: 'set-referer',
        ruleId: job.ruleId,
        hosts: [...hosts],
        referer: job.referer,
      });
    }
  };

  try {
    let url = job.url;
    await allowHosts([url]);
    let pl = await fetchPlaylist(url, signal);
    if (pl.type === 'master') {
      url = pl.variants[0].url;
      await allowHosts([url]);
      pl = await fetchPlaylist(url, signal);
    }
    if (!pl.endList) throw new Error('直播串流目前不支援下載');
    if (!pl.segments.length) throw new Error('播放清單沒有任何片段');
    if (pl.segments.some((s) => s.key && (s.key.method !== 'AES-128' || !s.key.url))) {
      throw new Error('此串流受 DRM 或 SAMPLE-AES 保護，無法下載');
    }

    const segs = pl.segments;
    await allowHosts([
      ...segs.map((s) => s.url),
      ...segs.filter((s) => s.key).map((s) => s.key.url),
      ...(pl.map ? [pl.map.url] : []),
    ]);

    const keys = new Map(); // key URL -> Promise<CryptoKey>
    const loadKey = (keyUrl) => {
      if (!keys.has(keyUrl)) {
        keys.set(
          keyUrl,
          fetchBytes(keyUrl, null, signal).then((raw) =>
            crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']),
          ),
        );
      }
      return keys.get(keyUrl);
    };

    const parts = new Array(segs.length);
    let next = 0;
    let done = 0;
    let bytes = 0;
    let lastReport = 0;
    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - lastReport < 300) return;
      lastReport = now;
      post({ type: 'job-progress', id: job.id, done, total: segs.length, bytes });
    };

    const worker = async () => {
      while (next < segs.length) {
        const i = next++;
        const seg = segs[i];
        let data = await fetchBytes(seg.url, seg.byteRange, signal);
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

    report(true);
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, segs.length) }, worker));
    const init = pl.map ? [await fetchBytes(pl.map.url, pl.map.byteRange, signal)] : [];
    report(true);

    // fMP4 streams (with an init map) concatenate into a playable MP4; the rest are MPEG-TS.
    const ext = pl.map ? 'mp4' : 'ts';
    const blob = new Blob([...init, ...parts], { type: pl.map ? 'video/mp4' : 'video/mp2t' });
    state.blobUrl = URL.createObjectURL(blob);
    post({ type: 'job-ready', id: job.id, blobUrl: state.blobUrl, ext, size: blob.size });
  } catch (e) {
    state.controller.abort();
    running.delete(job.id);
    post({ type: 'job-failed', id: job.id, cancelled: state.cancelled, error: e.message });
  }
}
