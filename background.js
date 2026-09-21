import { identityHeaders, pageHeaders } from './lib/headers.js';
import { parsePlaylist } from './lib/hls.js';
import { classify, filenameFor, sizeFromHeaders, urlExt } from './lib/media.js';

// Everything lives in storage.session because the service worker can be torn down at any
// moment and in-memory state would be lost with it:
//   tab:<id>   media detected in that tab
//   tracked    id of the browser tab the viewer window is following
//   jobs       HLS download jobs
//   fallbacks  { [downloadId]: { tabId, mediaId, filename } } file downloads that retry in
//              the page if the server refuses the extension's own request
const tabKey = (tabId) => `tab:${tabId}`;
const TRACKED = 'tracked';
const JOBS = 'jobs';
const FALLBACKS = 'fallbacks';
const VIEWER_PAGE = 'viewer/viewer.html';

const chains = new Map();

// Read-modify-write on one storage key, serialized so that bursts of webRequest events
// for the same tab cannot overwrite each other. `fn` returns the new value, or
// undefined to leave it untouched.
function update(key, fn) {
  const run = (chains.get(key) || Promise.resolve()).then(async () => {
    const { [key]: value } = await chrome.storage.session.get(key);
    const next = fn(value);
    if (next === undefined) return value;
    await chrome.storage.session.set({ [key]: next });
    return next;
  });
  chains.set(key, run.catch((e) => console.error(e)));
  return run;
}

// A variant or audio playlist already offered through its master is hidden behind it.
function linkChildren(list) {
  const parents = new Map();
  for (const m of list) {
    for (const v of [...(m.variants || []), ...(m.audio || [])]) parents.set(v.url, m.id);
  }
  return list.map((m) => (parents.has(m.url) && !m.parent ? { ...m, parent: parents.get(m.url) } : m));
}

async function addMedia(tabId, item) {
  let added = null;
  await update(tabKey(tabId), (list = []) => {
    const old = list.find((m) => m.url === item.url);
    if (!old) {
      added = { id: crypto.randomUUID(), detectedAt: Date.now(), ...item };
      return linkChildren([...list, added]);
    }
    // MSE captures keep growing while the video plays; a network sighting brings the
    // request headers that a DOM sighting of the same URL lacks.
    const grew = item.kind === 'mse' ? old.size !== item.size || old.truncated !== item.truncated : false;
    const learned = !old.headers && item.headers;
    if (grew || learned || (old.size == null && item.size != null)) {
      return list.map((m) =>
        m === old
          ? {
              ...m,
              size: item.size ?? m.size,
              truncated: item.truncated,
              headers: m.headers || item.headers,
              frameId: learned ? item.frameId : m.frameId,
            }
          : m,
      );
    }
  });
  if (added?.kind === 'hls') probe(tabId, added);
}

// The tab's top frame committed a new document: start a fresh list for it.
async function navigated(tabId) {
  await update(tabKey(tabId), () => []);
  abandonJobs(tabId);
}

// ---- Viewer window --------------------------------------------------------------------
// A standalone window listing the media of whichever normal browser tab is active, so the
// page itself runs in a real tab (nothing to block) and the list never closes on a click.

async function viewerContext() {
  const prefix = chrome.runtime.getURL(VIEWER_PAGE);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
  return contexts.find((c) => c.documentUrl?.startsWith(prefix)) || null;
}

async function track(tabId) {
  await chrome.storage.session.set({ [TRACKED]: tabId });
}

async function trackActiveIn(windowId) {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const win = await chrome.windows.get(windowId, { populate: true }).catch(() => null);
  if (win?.type !== 'normal') return;
  const active = win.tabs.find((t) => t.active);
  // Never follow the extension's own pages (e.g. the viewer opened as a normal tab).
  if (active && !active.url?.startsWith(chrome.runtime.getURL(''))) track(active.id);
}

// MSE capture hook: registered only while a viewer window exists, since it keeps a copy of
// everything a player buffers. Pages loaded before that are not captured.
const HOOK_ID = 'vd-mse-hook';

async function setCapture(on) {
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [HOOK_ID] });
  if (on && !registered.length) {
    await chrome.scripting.registerContentScripts([
      {
        id: HOOK_ID,
        matches: ['http://*/*', 'https://*/*'],
        js: ['inject/mse-hook.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: true,
        persistAcrossSessions: false,
      },
    ]);
  } else if (!on && registered.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [HOOK_ID] });
  }
}

async function openViewer(tab) {
  if (tab?.id != null) await track(tab.id);
  const existing = await viewerContext();
  if (existing) {
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.windows.create({
    url: chrome.runtime.getURL(VIEWER_PAGE),
    type: 'popup',
    width: 620,
    height: 460,
  });
}

// ---- File downloads -------------------------------------------------------------------
// chrome.downloads streams straight to disk and sends the browser's cookies plus the
// player's custom headers, but it can never send the page's Referer or Origin. If the
// server refuses it, the file is fetched again inside the page (see startPageJob).

async function findMedia(tabId, mediaId) {
  const { [tabKey(tabId)]: list = [] } = await chrome.storage.session.get(tabKey(tabId));
  return list.find((m) => m.id === mediaId) || null;
}

async function downloadFile({ tabId, mediaId, filename }) {
  const item = await findMedia(tabId, mediaId);
  if (!item) throw new Error('找不到這個媒體，頁面可能已經換頁');
  const headers = Object.entries(pageHeaders(item.headers)).map(([name, value]) => ({ name, value }));
  const start = (h) => chrome.downloads.download({ url: item.url, filename, conflictAction: 'uniquify', headers: h });
  // A header the downloads API considers unsafe makes it refuse outright; go without them.
  const id = await start(headers).catch(() => start([]));
  await update(FALLBACKS, (f = {}) => ({ ...f, [id]: { tabId, mediaId, filename } }));
  return id;
}

// ---- Asking the page ------------------------------------------------------------------
// Playlists and segments are fetched by the content script in the frame that loaded them,
// i.e. with the page's own origin, cookies and referer.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The content script may not be listening yet right after a navigation; retry briefly.
async function askPage(tabId, frameId, msg, tries = 6) {
  for (let i = 1; ; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg, { frameId: frameId ?? 0 });
    } catch (e) {
      if (i >= tries) throw new Error('無法連到頁面，請重新整理後再試');
      await sleep(500);
    }
  }
}

// ---- HLS probing ----------------------------------------------------------------------
// Fetches a freshly detected playlist so the viewer can show qualities, length and
// whether the stream is downloadable at all.

async function probe(tabId, item) {
  let info;
  try {
    const res = await askPage(tabId, item.frameId, {
      type: 'fetch-text',
      url: item.url,
      headers: pageHeaders(item.headers),
    });
    if (res?.error) throw new Error(res.error);
    const pl = parsePlaylist(res.text, item.url);
    info =
      pl.type === 'master'
        ? { variants: pl.variants, audio: pl.audio }
        : {
            duration: pl.duration,
            segments: pl.segments.length,
            live: !pl.endList,
            encryption: pl.encryption,
          };
  } catch (e) {
    info = { error: e.message };
  }
  await update(tabKey(tabId), (list = []) =>
    linkChildren(list.map((m) => (m.id === item.id ? { ...m, ...info, probed: true } : m))),
  );
}

// ---- HLS jobs -------------------------------------------------------------------------
// The page's content script downloads and assembles the stream; the service worker keeps
// the job record and saves the finished blob.

const patchJob = (id, patch) =>
  update(JOBS, (jobs = []) => jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)));

async function findJob(pred) {
  const { [JOBS]: jobs = [] } = await chrome.storage.session.get(JOBS);
  return jobs.find(pred) || null;
}

// kind 'hls' assembles a stream; kind 'file' fetches one file whole (the fallback above).
async function startPageJob({ kind = 'hls', tabId, mediaId, url, title, tag, filename }) {
  const item = await findMedia(tabId, mediaId);
  if (!item) throw new Error('找不到這個媒體，頁面可能已經換頁');
  url ??= item.url;
  const job = {
    id: crypto.randomUUID(),
    kind,
    tabId,
    frameId: item.frameId ?? 0,
    url,
    title,
    tag,
    filename: filename || filenameFor(title, 'ts', tag),
    status: 'running',
    done: 0,
    total: 0,
    bytes: 0,
    startedAt: Date.now(),
  };
  await update(JOBS, (jobs = []) => [job, ...jobs]);
  try {
    await askPage(tabId, job.frameId, {
      type: 'job-start',
      job: { id: job.id, kind, url, ext: item.ext, headers: pageHeaders(item.headers) },
    });
  } catch (e) {
    await patchJob(job.id, { status: 'failed', error: e.message });
  }
}

const releaseJob = (job) =>
  chrome.tabs.sendMessage(job.tabId, { type: 'job-release', id: job.id }, { frameId: job.frameId }).catch(() => {});

// Saves the blob the page assembled. The reply tells the page to save it itself when the
// downloads API refuses a blob URL from the page's origin.
async function onJobReady({ id, blobUrl, ext, size }) {
  const job = await findJob((j) => j.id === id);
  if (!job) return {};
  const filename = job.kind === 'file' ? job.filename : filenameFor(job.title, ext, job.tag);
  await patchJob(id, { status: 'saving', filename, bytes: size, blobUrl });
  try {
    const downloadId = await chrome.downloads.download({ url: blobUrl, filename, conflictAction: 'uniquify' });
    await patchJob(id, { downloadId });
    return {};
  } catch {
    return { anchor: true, filename };
  }
}

async function onJobFailed({ id, cancelled, error }) {
  await patchJob(id, cancelled ? { status: 'cancelled' } : { status: 'failed', error });
}

async function cancelJob(id) {
  const job = await findJob((j) => j.id === id);
  if (!job) return;
  try {
    await chrome.tabs.sendMessage(job.tabId, { type: 'job-cancel', id }, { frameId: job.frameId });
  } catch {
    await patchJob(id, { status: 'cancelled' });
  }
}

// A job runs inside its page, so leaving the page ends it.
async function abandonJobs(tabId) {
  await update(JOBS, (jobs = []) =>
    jobs.some((j) => j.tabId === tabId && j.status === 'running')
      ? jobs.map((j) => (j.tabId === tabId && j.status === 'running' ? { ...j, status: 'failed', error: '頁面已離開' } : j))
      : undefined,
  );
}

// Downloads the page started itself (anchor fallback) are matched to their job by URL.
chrome.downloads.onCreated.addListener(async (item) => {
  if (!item.url.startsWith('blob:')) return;
  const job = await findJob((j) => j.blobUrl === item.url && j.downloadId == null);
  if (job) patchJob(job.id, { downloadId: item.id });
});

chrome.downloads.onChanged.addListener(async (delta) => {
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  const readFallback = async () => (await chrome.storage.session.get(FALLBACKS))[FALLBACKS]?.[delta.id];
  let fallback = await readFallback();
  // A fast refusal can arrive before downloadFile() has recorded the fallback.
  if (!fallback && state === 'interrupted') {
    await sleep(300);
    fallback = await readFallback();
  }
  if (fallback) {
    update(FALLBACKS, (f = {}) => {
      const { [delta.id]: _, ...rest } = f;
      return rest;
    });
    // The server wanted the page's identity: drop the failed entry and fetch as the page.
    if (state === 'interrupted' && /^SERVER_/.test(delta.error?.current || '')) {
      chrome.downloads.erase({ id: delta.id }).catch(() => {});
      startPageJob({ kind: 'file', ...fallback }).catch((e) => console.error(e));
    }
    return;
  }
  const job = await findJob((j) => j.downloadId === delta.id);
  if (!job) return;
  await patchJob(job.id, state === 'complete' ? { status: 'done' } : { status: 'failed', error: '存檔被中斷' });
  releaseJob(job);
});

// ---- Wiring ---------------------------------------------------------------------------

chrome.action.onClicked.addListener(openViewer);

const MEDIA_FILTER = { urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'object', 'other'] };

// What the page sent for each in-flight request, kept until its response arrives.
// extraHeaders is needed to see Cookie and Referer.
const sentHeaders = new Map();

chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    if (d.tabId >= 0) sentHeaders.set(d.requestId, identityHeaders(d.requestHeaders));
  },
  MEDIA_FILTER,
  ['requestHeaders', 'extraHeaders'],
);

chrome.webRequest.onErrorOccurred.addListener((d) => sentHeaders.delete(d.requestId), MEDIA_FILTER);

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    const sent = sentHeaders.get(d.requestId);
    // Keep the entry across redirects; the next hop's headers replace it.
    if (d.statusCode < 300 || d.statusCode >= 400) sentHeaders.delete(d.requestId);
    if (d.tabId < 0 || d.statusCode < 200 || d.statusCode >= 300) return;
    const headers = {};
    for (const { name, value } of d.responseHeaders || []) headers[name.toLowerCase()] = value;
    const size = sizeFromHeaders(headers);
    const hit = classify(d.url, headers['content-type'], size);
    if (hit) addMedia(d.tabId, { url: d.url, ...hit, size, headers: sent, frameId: d.frameId });
  },
  MEDIA_FILTER,
  ['responseHeaders'],
);

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) navigated(d.tabId);
});

chrome.tabs.onActivated.addListener(({ windowId }) => trackActiveIn(windowId));
chrome.windows.onFocusChanged.addListener(trackActiveIn);

chrome.tabs.onRemoved.addListener(async (tabId) => {
  chrome.storage.session.remove(tabKey(tabId));
  chains.delete(tabKey(tabId));
  if (!(await viewerContext())) setCapture(false).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  switch (msg.type) {
    case 'dom-media': {
      const tabId = sender.tab?.id;
      if (tabId == null) return;
      for (const url of msg.urls) {
        // A <video src> without a recognizable extension is still a video.
        const hit = classify(url, '', null) ?? (urlExt(url) ? null : { kind: 'file', ext: 'mp4' });
        if (hit) addMedia(tabId, { url, ...hit, size: null, frameId: sender.frameId });
      }
      return;
    }
    case 'mse-streams': {
      const tabId = sender.tab?.id;
      if (tabId == null) return;
      for (const st of msg.streams) {
        addMedia(tabId, {
          url: `mse:${sender.frameId}:${st.id}`,
          kind: 'mse',
          mime: String(st.mime),
          size: Number(st.bytes) || 0,
          truncated: !!st.truncated,
          frameId: sender.frameId,
          streamId: st.id,
        });
      }
      return;
    }
    case 'save-mse':
      chrome.tabs
        .sendMessage(msg.tabId, { type: 'mse-save', id: msg.streamId, filename: msg.filename }, { frameId: msg.frameId })
        .catch(() => {});
      return;
    case 'capture-on':
      setCapture(true).then(() => reply(true), (e) => reply({ error: e.message }));
      return true;
    case 'download':
      downloadFile(msg).then((id) => reply({ id }), (e) => reply({ error: e.message }));
      return true;
    case 'download-hls':
      startPageJob({ ...msg, kind: 'hls' }).then(() => reply({ ok: true }), (e) => reply({ error: e.message }));
      return true;
    case 'cancel-job':
      cancelJob(msg.id);
      return;
    case 'job-progress':
      update(JOBS, (jobs = []) =>
        jobs.map((j) =>
          j.id === msg.id && j.status === 'running'
            ? { ...j, done: msg.done, total: msg.total, bytes: msg.bytes }
            : j,
        ),
      );
      return;
    case 'job-ready':
      onJobReady(msg).then(reply, () => reply({}));
      return true;
    case 'job-failed':
      onJobFailed(msg);
      return;
  }
});
