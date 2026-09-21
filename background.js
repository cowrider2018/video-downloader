import { identityHeaders, pageHeaders } from './lib/headers.js';
import { parseMpd, repExt } from './lib/dash.js';
import { parsePlaylist } from './lib/hls.js';
import { classify, filenameFor, sizeFromHeaders, urlExt } from './lib/media.js';

// Everything lives in storage.session because the service worker can be torn down at any
// moment and in-memory state would be lost with it:
//   tab:<id>   media detected in that tab
//   page:<id>  { url, title } of the page framed in a viewer tab
//   ids:<id>   { [host]: headers } the tab's latest request identity per host
//   viewers    { [tabId]: ruleId } open viewer tabs and their frame-header rule
//   jobs       downloads, newest first
const tabKey = (tabId) => `tab:${tabId}`;
const pageKey = (tabId) => `page:${tabId}`;
const idsKey = (tabId) => `ids:${tabId}`;
const VIEWERS = 'viewers';
const JOBS = 'jobs';
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newRuleId = () => 1 + Math.floor(Math.random() * 0x7ffffffe);
const removeRules = (ids) =>
  ids.length ? chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids }).catch(() => {}) : null;

// ---- Detected media -------------------------------------------------------------------

// URL without its query: players often add tokens or cache-busters to segment requests.
const bare = (url) => url.split(/[?#]/)[0];

// What a playlist already offers is hidden behind it: a master's variant, audio and subtitle
// playlists, and the segments of any playlist (fMP4 segments look like ordinary .mp4 files).
function linkChildren(list) {
  const parents = new Map();
  for (const m of list) {
    for (const v of [...(m.variants || []), ...(m.audio || [])]) parents.set(bare(v.url), m.id);
    for (const url of [...(m.subtitles || []), ...(m.segmentUrls || [])]) parents.set(bare(url), m.id);
  }
  return list.map((m) => {
    const parent = parents.get(bare(m.url));
    return parent && parent !== m.id && !m.parent ? { ...m, parent } : m;
  });
}

// Enough segment URLs to recognise a playlist's segments, without filling up storage.
const MAX_SEGMENT_URLS = 3000;

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
  if (added?.kind === 'hls' || added?.kind === 'dash') probe(tabId, added);
}

async function findMedia(tabId, mediaId) {
  const { [tabKey(tabId)]: list = [] } = await chrome.storage.session.get(tabKey(tabId));
  return list.find((m) => m.id === mediaId) || null;
}

// A new page is showing (top frame, or the frame inside a viewer): start a fresh list.
// Downloads are not tied to the page and keep running.
async function navigated(tabId, url) {
  await update(tabKey(tabId), () => []);
  // The new page may have reported its title before this (the two race): use it then.
  if (url) await update(pageKey(tabId), (p = {}) => ({ url, title: p.early?.url === url ? p.early.title : '' }));
  // An MSE capture lives in the page, unlike every other download.
  await update(JOBS, (jobs = []) =>
    jobs.some((j) => j.kind === 'mse' && j.tabId === tabId && ['running', 'paused'].includes(j.status))
      ? jobs.map((j) =>
          j.kind === 'mse' && j.tabId === tabId && ['running', 'paused'].includes(j.status)
            ? { ...j, status: 'failed', error: '頁面已離開' }
            : j,
        )
      : undefined,
  );
}

// ---- Request identity -----------------------------------------------------------------
// The headers each tab last sent to each host: cookies (SameSite and partitioned ones
// included, as the page saw them), referer, origin, auth and custom player headers.
// A download takes a snapshot when it is queued and replays it, so it neither needs the
// page to stay open nor picks up the identity of whatever page is shown later.

const identities = new Map(); // tabId -> { [host]: headers }

async function identityOf(tabId) {
  if (!identities.has(tabId)) {
    const { [idsKey(tabId)]: stored = {} } = await chrome.storage.session.get(idsKey(tabId));
    if (!identities.has(tabId)) identities.set(tabId, stored);
  }
  return identities.get(tabId);
}

async function rememberIdentity(tabId, url, headers) {
  const host = new URL(url).hostname;
  const ids = await identityOf(tabId);
  if (JSON.stringify(ids[host]) === JSON.stringify(headers)) return;
  ids[host] = headers;
  chrome.storage.session.set({ [idsKey(tabId)]: ids });
}

// The identity a download of `item` should present, per host: the media's own request
// for its host, what the page last sent elsewhere (e.g. segment CDNs), and for hosts the
// page never contacted, at least its referer, origin and custom player headers.
async function snapshotIdentity(tabId, item) {
  const hosts = { ...(await identityOf(tabId)) };
  const own = new URL(item.url).hostname;
  if (item.headers) hosts[own] = { ...hosts[own], ...item.headers };
  const fallback = { ...pageHeaders(item.headers) };
  for (const k of ['referer', 'origin']) if (item.headers?.[k]) fallback[k] = item.headers[k];
  return { hosts, fallback };
}

// One session rule per host for requests the extension itself makes (tabId -1).
async function installIdentity(job, hosts) {
  const known = { ...(job.rules || {}) };
  const addRules = [];
  for (const host of hosts) {
    if (known[host]) continue;
    const headers = job.identity?.hosts[host] || job.identity?.fallback || {};
    const requestHeaders = Object.entries(headers).map(([header, value]) => ({ header, operation: 'set', value }));
    if (!requestHeaders.length) continue;
    known[host] = newRuleId();
    addRules.push({
      id: known[host],
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders },
      condition: { requestDomains: [host], tabIds: [chrome.tabs.TAB_ID_NONE], resourceTypes: ['xmlhttprequest'] },
    });
  }
  if (!addRules.length) return;
  await chrome.declarativeNetRequest.updateSessionRules({ addRules });
  await patchJob(job.id, { rules: known });
}

// ---- Viewer window --------------------------------------------------------------------
// A standalone window: address bar, the page framed inside it, detected media and the
// download queue.

async function viewerContext() {
  const prefix = chrome.runtime.getURL(VIEWER_PAGE);
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
  return contexts.find((c) => c.documentUrl?.startsWith(prefix)) || null;
}

let viewersCache = null;

async function getViewers() {
  viewersCache ??= (await chrome.storage.session.get(VIEWERS))[VIEWERS] || {};
  return viewersCache;
}

const isViewer = async (tabId) => String(tabId) in (await getViewers());

// Sites refuse to be framed via X-Frame-Options / CSP frame-ancestors; strip both, but only
// for frames inside this viewer tab.
async function registerViewer(tabId) {
  const viewers = await getViewers();
  const ruleId = viewers[tabId] ?? newRuleId();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [
      {
        id: ruleId,
        priority: 2,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [
            { header: 'x-frame-options', operation: 'remove' },
            { header: 'content-security-policy', operation: 'remove' },
          ],
        },
        condition: { tabIds: [tabId], resourceTypes: ['sub_frame'] },
      },
    ],
  });
  viewersCache = await update(VIEWERS, (v = {}) => ({ ...v, [tabId]: ruleId }));
  await setCapture(true);
}

async function unregisterViewer(tabId) {
  const viewers = await getViewers();
  if (!(tabId in viewers)) return;
  removeRules([viewers[tabId]]);
  viewersCache = await update(VIEWERS, (v = {}) => {
    const { [tabId]: _, ...rest } = v;
    return rest;
  });
  if (!Object.keys(viewersCache).length) setCapture(false).catch(() => {});
}

// MSE capture hook: registered only while a viewer exists, since it keeps a copy of
// everything a player buffers.
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
  const existing = await viewerContext();
  if (existing) {
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  const start = /^https?:/i.test(tab?.url || '') ? `?url=${encodeURIComponent(tab.url)}` : '';
  await chrome.windows.create({
    url: chrome.runtime.getURL(VIEWER_PAGE) + start,
    type: 'popup',
    width: 1000,
    height: 860,
  });
}

// ---- HLS probing ----------------------------------------------------------------------
// The frame that loaded a playlist fetches it again, as itself, so the viewer can show
// qualities, length and whether the stream is downloadable at all.

// The content script may not be listening yet right after a navigation; retry briefly.
async function askPage(tabId, frameId, msg, tries = 6) {
  for (let i = 1; ; i++) {
    try {
      return await chrome.tabs.sendMessage(tabId, msg, { frameId: frameId ?? 0 });
    } catch {
      if (i >= tries) throw new Error('無法連到頁面，請重新整理後再試');
      await sleep(500);
    }
  }
}

function hlsInfo(text, url) {
  const pl = parsePlaylist(text, url);
  if (pl.type === 'master') return { variants: pl.variants, audio: pl.audio, subtitles: pl.subtitles };
  const segmentUrls = [...new Set([...(pl.map ? [bare(pl.map.url)] : []), ...pl.segments.map((s) => bare(s.url))])];
  return {
    duration: pl.duration,
    segments: pl.segments.length,
    live: !pl.endList,
    encryption: pl.encryption,
    segmentUrls: segmentUrls.slice(0, MAX_SEGMENT_URLS),
  };
}

function dashInfo(text, url) {
  const mpd = parseMpd(text, url);
  const segmentUrls = new Set();
  for (const r of mpd.reps) {
    if (mpd.live || segmentUrls.size >= MAX_SEGMENT_URLS) break;
    const { init, segments } = mpd.segmentsFor(r.id);
    for (const s of [...(init ? [init] : []), ...segments]) segmentUrls.add(bare(s.url));
  }
  const { live, drm, duration, reps } = mpd;
  return { live, drm, duration, reps, segmentUrls: [...segmentUrls].slice(0, MAX_SEGMENT_URLS) };
}

async function probe(tabId, item) {
  let info;
  try {
    const res = await askPage(tabId, item.frameId, {
      type: 'fetch-text',
      url: item.url,
      headers: pageHeaders(item.headers),
    });
    if (res?.error) throw new Error(res.error);
    info = item.kind === 'dash' ? dashInfo(res.text, item.url) : hlsInfo(res.text, item.url);
  } catch (e) {
    info = { error: e.message };
  }
  await update(tabKey(tabId), (list = []) =>
    linkChildren(list.map((m) => (m.id === item.id ? { ...m, ...info, probed: true } : m))),
  );
}

// ---- Downloads ------------------------------------------------------------------------
// Every download is a job in the queue, independent of the page it came from:
//   native  a file handed to chrome.downloads (streams to disk; sends cookies and the
//           player's custom headers, but never the page's referer or origin);
//   file    the same file fetched by the offscreen document with the page's full identity,
//           used when the server refuses the native download;
//   hls     a stream assembled by the offscreen document with the page's identity;
//   dash    one representation of a DASH stream, likewise;
//   mse     the page's own player buffering the whole video, captured in the page.

const patchJob = (id, patch) =>
  update(JOBS, (jobs = []) => jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)));

async function findJob(pred) {
  const { [JOBS]: jobs = [] } = await chrome.storage.session.get(JOBS);
  return jobs.find(pred) || null;
}

async function newJob(fields) {
  const job = { id: crypto.randomUUID(), status: 'running', done: 0, total: 0, bytes: 0, startedAt: Date.now(), ...fields };
  await update(JOBS, (jobs = []) => [job, ...jobs]);
  return job;
}

let creatingOffscreen = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Download and assemble media files in the background.',
    })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

const toOffscreen = (msg) => chrome.runtime.sendMessage({ target: 'offscreen', ...msg }).catch(() => {});

async function runInOffscreen(job, item) {
  await ensureOffscreen();
  toOffscreen({
    type: 'job-start',
    job: {
      id: job.id,
      kind: job.kind,
      url: job.url,
      repId: job.repId,
      ext: item.ext,
      headers: pageHeaders(item.headers),
    },
  });
}

async function downloadFile({ tabId, mediaId, filename }) {
  const item = await findMedia(tabId, mediaId);
  if (!item) throw new Error('找不到這個媒體，頁面可能已經換頁');
  const headers = Object.entries(pageHeaders(item.headers)).map(([name, value]) => ({ name, value }));
  const job = await newJob({
    kind: 'native',
    tabId,
    url: item.url,
    filename,
    ext: item.ext,
    item,
    identity: await snapshotIdentity(tabId, item),
  });
  const start = (h) => chrome.downloads.download({ url: item.url, filename, conflictAction: 'uniquify', headers: h });
  try {
    // A header the downloads API considers unsafe makes it refuse outright; go without them.
    const downloadId = await start(headers).catch(() => start([]));
    await patchJob(job.id, { downloadId });
  } catch (e) {
    await patchJob(job.id, { status: 'failed', error: e.message });
  }
}

async function startHls({ tabId, mediaId, url, title, tag }) {
  const item = await findMedia(tabId, mediaId);
  if (!item) throw new Error('找不到這個串流，頁面可能已經換頁');
  const job = await newJob({
    kind: 'hls',
    tabId,
    url,
    title,
    tag,
    filename: filenameFor(title, 'ts', tag),
    identity: await snapshotIdentity(tabId, item),
  });
  await runInOffscreen(job, item);
}

async function startDash({ tabId, mediaId, repId, title, tag }) {
  const item = await findMedia(tabId, mediaId);
  if (!item) throw new Error('找不到這個串流，頁面可能已經換頁');
  const rep = item.reps?.find((r) => r.id === repId);
  if (!rep) throw new Error('找不到這個畫質');
  const job = await newJob({
    kind: 'dash',
    tabId,
    url: item.url,
    repId,
    title,
    tag,
    filename: filenameFor(title, repExt(rep), tag),
    identity: await snapshotIdentity(tabId, item),
  });
  await runInOffscreen(job, item);
}

// ---- MSE captures -------------------------------------------------------------------
// The page's own player buffers the whole video while the hook walks the playhead ahead
// (inject/mse-hook.js); the content script assembles the tracks and hands back blob: URLs.

const toPage = (job, msg) =>
  chrome.tabs.sendMessage(job.tabId, { ...msg, id: job.id }, { frameId: job.frameId ?? 0 }).catch(() => {});

async function startMse({ tabId, mediaId, title }) {
  const item = await findMedia(tabId, mediaId);
  if (!item) throw new Error('找不到這個媒體，頁面可能已經換頁');
  const job = await newJob({
    kind: 'mse',
    tabId,
    frameId: item.frameId ?? 0,
    source: item.source,
    url: item.url,
    title,
    filename: filenameFor(title, 'mp4'),
  });
  toPage(job, { type: 'mse-capture', source: item.source });
}

// Saves the assembled files. Replies with the ones the downloads API refused, for the page
// to save itself.
async function onMseReady({ id, files }) {
  const job = await findJob((j) => j.id === id);
  if (!job) return {};
  const named = files.map((f) => ({ ...f, filename: filenameFor(job.title, f.ext, f.label) }));
  await patchJob(id, {
    status: 'saving',
    filename: named[0].filename,
    bytes: named.reduce((n, f) => n + f.size, 0),
    blobUrls: named.map((f) => f.blobUrl),
  });
  const anchors = [];
  let downloadId = null;
  for (const f of named) {
    try {
      const d = await chrome.downloads.download({ url: f.blobUrl, filename: f.filename, conflictAction: 'uniquify' });
      downloadId ??= d;
    } catch {
      anchors.push(f);
    }
  }
  if (downloadId != null) await patchJob(id, { downloadId });
  return { anchors };
}

// Downloads the page started itself are matched to their capture by URL.
chrome.downloads.onCreated.addListener(async (item) => {
  if (!item.url.startsWith('blob:')) return;
  const job = await findJob((j) => j.blobUrls?.includes(item.url) && j.downloadId == null);
  if (job) patchJob(job.id, { downloadId: item.id });
});

// A native download the server refused: fetch it again with the page's identity.
async function retryAsPage(job) {
  const item = job.item;
  await patchJob(job.id, { kind: 'file', status: 'running', downloadId: null });
  await runInOffscreen({ ...job, kind: 'file' }, item);
}

async function onJobReady({ id, blobUrl, ext, size }) {
  const job = await findJob((j) => j.id === id);
  // Deleted while it was finishing: just let go of the blob.
  if (!job) return void toOffscreen({ type: 'release', id });
  const filename = job.kind === 'hls' || job.kind === 'dash' ? filenameFor(job.title, ext, job.tag) : job.filename;
  await patchJob(id, { status: 'saving', filename, bytes: size, done: job.total || size, total: job.total || size });
  try {
    const downloadId = await chrome.downloads.download({ url: blobUrl, filename, conflictAction: 'uniquify' });
    await patchJob(id, { downloadId });
  } catch (e) {
    await patchJob(id, { status: 'failed', error: e.message });
    finishJob(job);
  }
}

// Drops the job's header rules and blob; closes the offscreen document when idle.
async function finishJob(job) {
  const latest = (await findJob((j) => j.id === job.id)) || job;
  removeRules(Object.values(latest.rules || {}));
  if (job.kind === 'mse') toPage(job, { type: 'mse-release' });
  else toOffscreen({ type: 'release', id: job.id });
  const { [JOBS]: jobs = [] } = await chrome.storage.session.get(JOBS);
  const busy = jobs.some((j) => ['file', 'hls', 'dash'].includes(j.kind) && ['running', 'paused', 'saving'].includes(j.status));
  if (!busy) chrome.offscreen.closeDocument().catch(() => {});
}

async function onJobFailed({ id, cancelled, error }) {
  const job = await findJob((j) => j.id === id);
  await patchJob(id, cancelled ? { status: 'cancelled' } : { status: 'failed', error });
  if (job) finishJob(job);
}

// Pausing keeps what has been downloaded; resuming carries on from there.
async function pauseJob(id) {
  const job = await findJob((j) => j.id === id);
  if (job?.status !== 'running') return;
  await patchJob(id, { status: 'paused' });
  if (job.kind === 'native') {
    if (job.downloadId != null) chrome.downloads.pause(job.downloadId).catch(() => {});
  } else if (job.kind === 'mse') {
    toPage(job, { type: 'mse-pause' });
  } else {
    toOffscreen({ type: 'pause', id });
  }
}

async function resumeJob(id) {
  const job = await findJob((j) => j.id === id);
  if (job?.status !== 'paused') return;
  await patchJob(id, { status: 'running' });
  if (job.kind === 'native') {
    if (job.downloadId != null) chrome.downloads.resume(job.downloadId).catch(() => {});
  } else if (job.kind === 'mse') {
    toPage(job, { type: 'mse-resume' });
  } else {
    toOffscreen({ type: 'resume', id });
  }
}

// Removes a job from the queue, cancelling it first if it is still going (the partial data
// goes with it). A finished file stays on disk.
async function deleteJob(id) {
  const job = await findJob((j) => j.id === id);
  if (!job) return;
  await update(JOBS, (jobs = []) => jobs.filter((j) => j.id !== id));
  const unfinished = ['running', 'paused', 'saving'].includes(job.status);
  if (!unfinished) return;
  if (job.downloadId != null) {
    await chrome.downloads.cancel(job.downloadId).catch(() => {});
    chrome.downloads.erase({ id: job.downloadId }).catch(() => {});
  }
  if (job.kind === 'mse') {
    toPage(job, { type: 'mse-cancel' });
    finishJob(job);
  } else if (job.kind !== 'native') {
    toOffscreen({ type: 'cancel', id });
    finishJob(job);
  }
}

chrome.downloads.onChanged.addListener(async (delta) => {
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  let job = await findJob((j) => j.downloadId === delta.id);
  // A fast refusal can arrive before downloadFile() has stored the download id.
  if (!job && state === 'interrupted') {
    await sleep(300);
    job = await findJob((j) => j.downloadId === delta.id);
  }
  if (!job || job.status === 'cancelled') return;
  if (state === 'complete') {
    await patchJob(job.id, { status: 'done' });
  } else if (job.kind === 'native' && /^SERVER_/.test(delta.error?.current || '')) {
    chrome.downloads.erase({ id: delta.id }).catch(() => {});
    retryAsPage(job).catch((e) => patchJob(job.id, { status: 'failed', error: e.message }));
    return;
  } else {
    await patchJob(job.id, { status: 'failed', error: delta.error?.current || '存檔被中斷' });
  }
  if (job.kind !== 'native') finishJob(job);
});

// ---- Wiring ---------------------------------------------------------------------------

chrome.action.onClicked.addListener(openViewer);

const MEDIA_FILTER = { urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'object', 'other'] };

// What the page sent for each in-flight request, kept until its response arrives.
// extraHeaders is needed to see Cookie and Referer.
const sentHeaders = new Map();

chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const headers = identityHeaders(d.requestHeaders);
    sentHeaders.set(d.requestId, headers);
    rememberIdentity(d.tabId, d.url, headers);
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

// In a viewer the page lives in the frame directly under the viewer page.
chrome.webNavigation.onCommitted.addListener(async (d) => {
  const viewer = await isViewer(d.tabId);
  if (d.frameId === 0 && !viewer) navigated(d.tabId);
  else if (viewer && d.parentFrameId === 0 && /^https?:/i.test(d.url)) navigated(d.tabId, d.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove([tabKey(tabId), pageKey(tabId), idsKey(tabId)]);
  for (const key of [tabKey(tabId), pageKey(tabId)]) chains.delete(key);
  identities.delete(tabId);
  unregisterViewer(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target === 'offscreen') return;
  switch (msg.type) {
    case 'viewer-open':
      registerViewer(sender.tab.id).then(() => reply(true), (e) => reply({ error: e.message }));
      return true;
    case 'page-title': {
      const tabId = sender.tab?.id;
      if (tabId == null) return;
      isViewer(tabId).then((yes) => {
        if (yes) {
          update(pageKey(tabId), (p = {}) =>
            p.url === msg.url ? { ...p, title: msg.title } : { ...p, early: { url: msg.url, title: msg.title } },
          );
        }
      });
      return;
    }
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
          source: st.source,
        });
      }
      return;
    }
    case 'download-mse':
      startMse(msg).then(() => reply({ ok: true }), (e) => reply({ error: e.message }));
      return true;
    case 'mse-ready':
      onMseReady(msg).then(reply, () => reply({}));
      return true;
    case 'download':
      downloadFile(msg).then(() => reply({ ok: true }), (e) => reply({ error: e.message }));
      return true;
    case 'download-dash':
      startDash(msg).then(() => reply({ ok: true }), (e) => reply({ error: e.message }));
      return true;
    case 'download-hls':
      startHls(msg).then(() => reply({ ok: true }), (e) => reply({ error: e.message }));
      return true;
    case 'pause-job':
      pauseJob(msg.id);
      return;
    case 'resume-job':
      resumeJob(msg.id);
      return;
    case 'delete-job':
      deleteJob(msg.id);
      return;
    case 'identity':
      findJob((j) => j.id === msg.id)
        .then((job) => job && installIdentity(job, msg.hosts))
        .then(() => reply(true), (e) => reply({ error: e.message }));
      return true;
    case 'job-progress':
      update(JOBS, (jobs = []) =>
        jobs.map((j) =>
          j.id === msg.id && ['running', 'paused'].includes(j.status)
            ? { ...j, done: msg.done, total: msg.total, bytes: msg.bytes }
            : j,
        ),
      );
      return;
    case 'job-ready':
      onJobReady(msg);
      return;
    case 'job-failed':
      onJobFailed(msg);
      return;
  }
});
