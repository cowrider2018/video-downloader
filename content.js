// Runs in every page and frame from document_start. It:
//  1. reports <video>/<audio> sources and <img> images (covers media served from cache);
//  2. bridges inject/mse-hook.js, which lives in the page's world, and assembles its captures;
//  3. fetches playlists for probing *as the page*: same origin, cookies and referer as the
//     player's own requests, so sites that check who is asking still answer;
//  4. reports the title of the page framed in the viewer window.
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

  // ---- DOM images -----------------------------------------------------------------------
  // Covers images served from cache, which the network never shows, and tells how large
  // each one is. Smaller than this on either side: icons, avatars, buttons.
  const MIN_IMAGE_SIDE = 100;
  const seenImages = new Set();

  function reportImages(imgs) {
    const fresh = [];
    for (const img of imgs) {
      const url = img.currentSrc || img.src;
      if (!url || !/^https?:/i.test(url) || seenImages.has(url) || !img.complete) continue;
      if (img.naturalWidth < MIN_IMAGE_SIDE || img.naturalHeight < MIN_IMAGE_SIDE) continue;
      seenImages.add(url);
      fresh.push({ url, width: img.naturalWidth, height: img.naturalHeight });
    }
    if (fresh.length) send({ type: 'dom-images', images: fresh });
  }

  // Load events do not bubble either; lazy-loaded and srcset-switched images arrive this way.
  document.addEventListener(
    'load',
    (e) => {
      if (e.target instanceof HTMLImageElement) reportImages([e.target]);
    },
    true,
  );
  const scanImages = () => reportImages(document.images);
  if (document.readyState === 'complete') scanImages();
  else window.addEventListener('load', scanImages);

  // ---- MSE hook bridge ------------------------------------------------------------------

  const TAG = '__vd_mse__';

  const toHook = (cmd, extra) => window.postMessage({ [TAG]: cmd, ...extra }, '*');

  // A capture job: the hook walks the player's buffer; its tracks come back here to be put
  // in order (lib/fragments.js) and handed to the extension as files.
  const passes = new Map(); // job id -> how many times the buffer has been walked
  const lengths = new Map(); // job id -> longest duration the player has reported
  const MAX_PASSES = 2;

  const extOf = (mime) => {
    const type = mime.split(';')[0].trim();
    if (type === 'audio/mp4') return 'm4a';
    if (type === 'audio/webm') return 'weba';
    return type.endsWith('/webm') ? 'webm' : 'mp4';
  };

  // Overlapping [from, to] ranges joined, in order.
  function merge(ranges) {
    const out = [];
    for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
      const last = out[out.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    }
    return out;
  }

  async function finishCapture(job, done) {
    const { tracks } = done;
    try {
      const { assembleTrack, gaps, indexedMp4, muxable, muxMp4 } = await import(chrome.runtime.getURL('lib/fragments.js'));
      const duration = Math.max(lengths.get(job) || 0, done.duration || 0);
      // Qualities the player switched between are combined; only stretches no quality has
      // (the player never buffered them) are walked again.
      const built = tracks.map((t) => ({ t, a: assembleTrack(t.chunks, t.mime) }));
      const holes = merge(built.flatMap(({ a }) => gaps(a.starts, duration)));
      const pass = passes.get(job) || 1;
      if (holes.length && pass < MAX_PASSES) {
        passes.set(job, pass + 1);
        toHook('capture', { job, source: done.source, ranges: holes });
        return;
      }
      passes.delete(job);
      lengths.delete(job);
      // One fMP4 video and one fMP4 audio track become a single MP4; anything else is saved
      // as one file per track.
      const video = built.find(({ t }) => t.mime.startsWith('video/') && extOf(t.mime) === 'mp4');
      const audio = built.find(({ t }) => t.mime.startsWith('audio/') && extOf(t.mime) === 'm4a');
      let files;
      if (built.length === 2 && video && audio && muxable(video.a, audio.a)) {
        const blob = new Blob([muxMp4(video.a, audio.a)], { type: 'video/mp4' });
        files = [{ blobUrl: URL.createObjectURL(blob), ext: 'mp4', label: '', size: blob.size }];
      } else {
        files = built.map(({ t, a }) => {
          const bytes = extOf(t.mime) === 'mp4' || extOf(t.mime) === 'm4a' ? [indexedMp4(a)] : [a.init, ...a.fragments];
          const blob = new Blob(bytes, { type: t.mime.split(';')[0] });
          const label = tracks.length > 1 ? (t.mime.startsWith('audio/') ? '音訊' : '影像') : '';
          return { blobUrl: URL.createObjectURL(blob), ext: extOf(t.mime), label, size: blob.size };
        });
      }
      const res = await send({ type: 'mse-ready', id: job, files, title: document.title });
      // The downloads API may refuse a blob: URL of the page's origin; save from the page then.
      for (const a of res?.anchors || []) {
        const link = document.createElement('a');
        link.href = a.blobUrl;
        link.download = a.filename;
        link.style.display = 'none';
        document.documentElement.appendChild(link);
        link.click();
        link.remove();
      }
    } catch (e) {
      send({ type: 'job-failed', id: job, error: e.message });
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data !== 'object') return;
    const d = e.data;
    switch (d[TAG]) {
      case 'streams':
        if (Array.isArray(d.streams)) send({ type: 'mse-streams', streams: d.streams });
        break;
      case 'walk-progress': {
        // Some players report a shorter duration for a while; keep the longest seen.
        const duration = Math.max(lengths.get(d.job) || 0, d.duration || 0);
        lengths.set(d.job, duration);
        send({ type: 'job-progress', id: d.job, done: Math.round(d.at * 1000), total: Math.round(duration * 1000), bytes: 0 });
        break;
      }
      case 'walk-done':
        finishCapture(d.job, d);
        break;
      case 'walk-failed':
        passes.delete(d.job);
        lengths.delete(d.job);
        send({ type: 'job-failed', id: d.job, error: d.error, cancelled: d.cancelled });
        break;
    }
  });

  // The hook may have announced streams before this script started listening.
  window.postMessage({ [TAG]: 'hello' }, '*');

  // ---- Fetching as the page -------------------------------------------------------------

  const lib = () => import(chrome.runtime.getURL('lib/jobs.js'));

  // Cross-origin CDNs answer either credentialed requests (specific Allow-Origin) or
  // anonymous ones (Allow-Origin: *), never both; learn which per host from the first try.
  const hostMode = new Map();

  // fetch() as the page, adding the custom headers the player itself sent. If those make
  // the server refuse the CORS preflight, go without them.
  const pageFetch = (extraHeaders = {}) => async (url, init = {}) => {
    const host = new URL(url).host;
    const plain = (credentials) => fetch(url, { ...init, credentials });
    const go = async (credentials) => {
      if (!Object.keys(extraHeaders).length) return plain(credentials);
      try {
        return await fetch(url, { ...init, headers: { ...extraHeaders, ...init.headers }, credentials });
      } catch (e) {
        if (init.signal?.aborted || !(e instanceof TypeError)) throw e;
        return plain(credentials);
      }
    };
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

  chrome.runtime.onMessage.addListener((msg, sender, reply) => {
    switch (msg.type) {
      case 'mse-capture':
        toHook('capture', { job: msg.id, source: msg.source });
        return;
      case 'mse-pause':
      case 'mse-resume':
      case 'mse-cancel':
        toHook(`capture-${msg.type.slice(4)}`, { job: msg.id });
        return;
      case 'fetch-text':
        lib()
          .then(({ makeFetchBytes }) => makeFetchBytes({ fetchImpl: pageFetch(msg.headers) })(msg.url, null))
          .then(
            (bytes) => reply({ text: new TextDecoder().decode(bytes) }),
            (e) => reply({ error: e.message }),
          );
        return true;
    }
  });

  // ---- Title of the page shown in the viewer --------------------------------------------

  const inViewer =
    window !== window.top &&
    window.parent === window.top &&
    location.ancestorOrigins?.[0]?.startsWith('chrome-extension://');
  if (inViewer) {
    // The viewer's page frame and its capture frames alike: say which (the iframe's name, read
    // before the page's own scripts could change it) as the page starts, and when it is in.
    send({ type: 'frame-role', name: window.name, url: location.href });
    const loaded = () => send({ type: 'frame-loaded' });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', loaded);
    else loaded();
    let last = null;
    const sendTitle = () => {
      if (document.title === last) return;
      last = document.title;
      send({ type: 'page-title', title: last, url: location.href });
    };
    const watch = () => {
      sendTitle();
      new MutationObserver(sendTitle).observe(document.head || document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
    else watch();
  }
})();
