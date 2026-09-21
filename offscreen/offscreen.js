// Runs HLS jobs and hands the assembled blob: URL back to the service worker, which cannot
// create blob URLs itself.
import { makeFetchBytes, runHlsJob } from '../lib/hls-job.js';

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

async function run(job) {
  const state = { controller: new AbortController(), cancelled: false, blobUrl: null };
  running.set(job.id, state);
  const { signal } = state.controller;
  const hosts = new Set();

  // Many CDNs refuse segment requests without the page's Referer; the service worker
  // installs a header rule for every host this job touches.
  const beforeFetch = async (urls) => {
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

  let lastReport = 0;
  const onProgress = ({ done, total, bytes }) => {
    const now = Date.now();
    if (done !== total && now - lastReport < 300) return;
    lastReport = now;
    post({ type: 'job-progress', id: job.id, done, total, bytes });
  };

  try {
    const fetchBytes = makeFetchBytes({ signal, init: { credentials: 'include' } });
    const { blob, ext } = await runHlsJob(job.url, { fetchBytes, signal, onProgress, beforeFetch });
    state.blobUrl = URL.createObjectURL(blob);
    post({ type: 'job-ready', id: job.id, blobUrl: state.blobUrl, ext, size: blob.size });
  } catch (e) {
    state.controller.abort();
    running.delete(job.id);
    post({ type: 'job-failed', id: job.id, cancelled: state.cancelled, error: e.message });
  }
}
