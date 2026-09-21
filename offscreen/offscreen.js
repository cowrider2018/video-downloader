// Runs download jobs in the background, independent of the page they came from. Requests
// carry the page's identity through header rules the service worker installs per host
// (see installIdentity); the finished blob: URL goes back to the worker, which cannot
// create blob URLs itself.
import { fetchFile, makeFetchBytes, runHlsJob } from '../lib/hls-job.js';

const running = new Map(); // job id -> { controller, cancelled, blobUrl }

const post = (msg) => chrome.runtime.sendMessage({ target: 'background', ...msg }).catch(() => {});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target !== 'offscreen') return;
  if (msg.type === 'job-start') run(msg.job);
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

async function run(job) {
  const state = { controller: new AbortController(), cancelled: false, blobUrl: null };
  running.set(job.id, state);
  const { signal } = state.controller;

  const hosts = new Set();
  const beforeFetch = async (urls) => {
    const fresh = [...new Set(urls.map((u) => new URL(u).hostname))].filter((h) => !hosts.has(h));
    if (!fresh.length) return;
    fresh.forEach((h) => hosts.add(h));
    await chrome.runtime.sendMessage({ target: 'background', type: 'identity', id: job.id, hosts: fresh });
  };

  // The player's custom headers go on every request; cookies, referer and origin come
  // from the identity rules.
  const fetchImpl = (url, init) =>
    fetch(url, { ...init, headers: { ...job.headers, ...init.headers }, credentials: 'include' });

  let lastReport = 0;
  const onProgress = ({ done, total, bytes }) => {
    const now = Date.now();
    if (done !== total && now - lastReport < 300) return;
    lastReport = now;
    post({ type: 'job-progress', id: job.id, done, total, bytes });
  };

  try {
    let blob;
    let ext = job.ext;
    if (job.kind === 'file') {
      await beforeFetch([job.url]);
      blob = await fetchFile(job.url, { fetchImpl, signal, onProgress });
    } else {
      const fetchBytes = makeFetchBytes({ signal, fetchImpl });
      ({ blob, ext } = await runHlsJob(job.url, { fetchBytes, signal, onProgress, beforeFetch }));
    }
    state.blobUrl = URL.createObjectURL(blob);
    post({ type: 'job-ready', id: job.id, blobUrl: state.blobUrl, ext, size: blob.size });
  } catch (e) {
    state.controller.abort();
    running.delete(job.id);
    post({ type: 'job-failed', id: job.id, cancelled: state.cancelled, error: e.message });
  }
}
