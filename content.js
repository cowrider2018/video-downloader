// Runs in every page and frame from document_start. Three jobs:
//  1. report <video>/<audio> sources (covers media served from cache);
//  2. bridge inject/mse-hook.js, which lives in the page's world;
//  3. fetch on the extension's behalf *as the page*: same origin, cookies and referer as the
//     player's own requests, so sites that check who is asking still answer.
(() => {
  const send = (msg) => {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      // Extension was reloaded; this orphaned script can no longer talk to it.
      return Promise.resolve();
    }
  };

  // ---- DOM media ------------------------------------------------------------------------

  const seen = new Set();

  function report(urls) {
    const fresh = urls.filter((u) => u && /^https?:/i.test(u) && !seen.has(u));
    if (!fresh.length) return;
    fresh.forEach((u) => seen.add(u));
    send({ type: 'dom-media', urls: fresh });
  }

  function scan() {
    const urls = [];
    for (const el of document.querySelectorAll('video, audio')) {
      urls.push(el.currentSrc, el.src);
      for (const s of el.querySelectorAll('source')) urls.push(s.src);
    }
    report(urls);
  }

  // Media events do not bubble, but they can be caught in the capture phase.
  document.addEventListener(
    'loadstart',
    (e) => {
      if (e.target instanceof HTMLMediaElement) report([e.target.currentSrc || e.target.src]);
    },
    true,
  );
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan);
  else scan();

  // ---- MSE hook bridge ------------------------------------------------------------------

  const TAG = '__vd_mse__';

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data !== 'object') return;
    if (e.data[TAG] === 'streams' && Array.isArray(e.data.streams)) {
      send({ type: 'mse-streams', streams: e.data.streams });
    }
  });

  // The hook may have announced streams before this script started listening.
  window.postMessage({ [TAG]: 'hello' }, '*');

  // ---- Fetching as the page -------------------------------------------------------------

  const lib = () => import(chrome.runtime.getURL('lib/hls-job.js'));

  // Cross-origin CDNs answer either credentialed requests (specific Allow-Origin) or
  // anonymous ones (Allow-Origin: *), never both; learn which per host from the first try.
  const hostMode = new Map();

  // fetch() as the page, adding the custom headers the player itself sent.
  const pageFetch = (extraHeaders = {}) => async (url, init = {}) => {
    const host = new URL(url).host;
    const go = (credentials) =>
      fetch(url, { ...init, headers: { ...extraHeaders, ...init.headers }, credentials });
    const known = hostMode.get(host);
    if (known) return go(known);
    try {
      const res = await go('include');
      hostMode.set(host, 'include');
      return res;
    } catch (e) {
      if (init.signal?.aborted || !(e instanceof TypeError)) throw e;
      hostMode.set(host, 'same-origin');
      return go('same-origin');
    }
  };

  const jobs = new Map(); // job id -> { controller, cancelled, blobUrl }

  async function runJob(job) {
    const state = { controller: new AbortController(), cancelled: false, blobUrl: null };
    jobs.set(job.id, state);
    const { signal } = state.controller;
    let lastReport = 0;
    const onProgress = ({ done, total, bytes }) => {
      const now = Date.now();
      if (done !== total && now - lastReport < 300) return;
      lastReport = now;
      send({ type: 'job-progress', id: job.id, done, total, bytes });
    };
    try {
      const { fetchFile, makeFetchBytes, runHlsJob } = await lib();
      const fetchImpl = pageFetch(job.headers);
      let blob;
      let ext = job.ext;
      if (job.kind === 'file') {
        blob = await fetchFile(job.url, { fetchImpl, signal, onProgress });
      } else {
        const fetchBytes = makeFetchBytes({ signal, fetchImpl });
        ({ blob, ext } = await runHlsJob(job.url, { fetchBytes, signal, onProgress }));
      }
      state.blobUrl = URL.createObjectURL(blob);
      const res = await send({ type: 'job-ready', id: job.id, blobUrl: state.blobUrl, ext, size: blob.size });
      // The extension could not take the blob itself; save it from the page instead.
      if (res?.anchor) {
        const a = document.createElement('a');
        a.href = state.blobUrl;
        a.download = res.filename;
        a.style.display = 'none';
        document.documentElement.appendChild(a);
        a.click();
        a.remove();
      }
    } catch (e) {
      state.controller.abort();
      jobs.delete(job.id);
      send({ type: 'job-failed', id: job.id, cancelled: state.cancelled, error: e.message });
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    switch (msg.type) {
      case 'mse-save':
        window.postMessage({ [TAG]: 'save', id: msg.id, filename: msg.filename }, '*');
        return;
      case 'fetch-text':
        lib()
          .then(({ makeFetchBytes }) => makeFetchBytes({ fetchImpl: pageFetch(msg.headers) })(msg.url, null))
          .then(
            (bytes) => reply({ text: new TextDecoder().decode(bytes) }),
            (e) => reply({ error: e.message }),
          );
        return true;
      case 'job-start':
        runJob(msg.job);
        return;
      case 'job-cancel': {
        const s = jobs.get(msg.id);
        if (s) {
          s.cancelled = true;
          s.controller.abort();
        }
        return;
      }
      case 'job-release': {
        const s = jobs.get(msg.id);
        if (s?.blobUrl) URL.revokeObjectURL(s.blobUrl);
        jobs.delete(msg.id);
        return;
      }
    }
  });
})();
