import { identityHeaders, pageHeaders } from './lib/headers.js';
import { parseMpd, repExt, repLabel } from './lib/dash.js';
import { audioFor, parsePlaylist, variantLabel } from './lib/hls.js';
import { classify, filenameFor, imageFilename, sizeFromHeaders, urlExt } from './lib/media.js';

// Everything lives in storage.session because the service worker can be torn down at any
// moment and in-memory state would be lost with it:
//   tab:<id>   media detected in that tab
//   page:<id>  { url, title } of the page framed in a viewer tab
//   ids:<id>   { [host]: headers } the tab's latest request identity per host
//   viewers    { [tabId]: { ruleId, frameId } } open viewer tabs: their frame-header rule and
//              the frame showing the page (capture frames are other frames of the same tab)
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

// Events about one tab's page (navigation, media, players, title) handled strictly in the
// order they arrived: their handlers look things up asynchronously, and a new page's media
// must not land before the navigation that clears the old page's list.
const tabTasks = new Map();
function inOrder(tabId, task) {
  const run = (tabTasks.get(tabId) || Promise.resolve()).then(task).catch((e) => console.error(e));
  tabTasks.set(tabId, run);
  return run;
}
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

// An endless feed keeps loading images; past this many a page's list stops taking more.
const MAX_IMAGES = 500;

async function addMedia(tabId, item) {
  let added = null;
  await update(tabKey(tabId), (list = []) => {
    const old = list.find((m) => m.url === item.url);
    if (!old) {
      if (item.kind === 'image' && list.filter((m) => m.kind === 'image').length >= MAX_IMAGES) return undefined;
      added = { id: crypto.randomUUID(), detectedAt: Date.now(), ...item };
      return linkChildren([...list, added]);
    }
    // MSE captures keep growing while the video plays; a network sighting brings the
    // request headers that a DOM sighting of the same URL lacks.
    const grew = item.kind === 'mse' ? old.size !== item.size || old.truncated !== item.truncated : false;
    const learned = !old.headers && item.headers;
    // The page tells an image's dimensions; the network its size and real type.
    const measured = item.width && !old.width;
    if (grew || learned || measured || (old.size == null && item.size != null)) {
      return list.map((m) =>
        m === old
          ? {
              ...m,
              size: item.size ?? m.size,
              truncated: item.truncated,
              headers: m.headers || item.headers,
              frameId: learned ? item.frameId : m.frameId,
              width: m.width ?? item.width,
              height: m.height ?? item.height,
              ext: m.kind === 'image' && item.size != null ? item.ext : m.ext,
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
async function navigated(tabId, url, frameId) {
  await update(tabKey(tabId), () => []);
  // The new page may have reported its title before this (the two race): use it then.
  if (url) await update(pageKey(tabId), (p = {}) => ({ url, frameId, title: p.early?.url === url ? p.early.title : '' }));
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
  // Images keep no headers of their own; image hosts check the referer, so send the page's.
  if (item.kind === 'image' && !fallback.referer) fallback.referer = await pageUrlOf(tabId);
  return { hosts, fallback };
}

async function pageUrlOf(tabId) {
  const { [pageKey(tabId)]: page = {} } = await chrome.storage.session.get(pageKey(tabId));
  return page.url || '';
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

// The frame of a viewer tab that shows the page (not a capture frame), or null.
const pageFrameOf = async (tabId) => (await getViewers())[tabId]?.frameId ?? null;

// Whether a frame belongs to a capture: what it loads or reports is not the page's.
async function isCaptureFrame(tabId, frameId) {
  const { [JOBS]: jobs = [] } = await chrome.storage.session.get(JOBS);
  return jobs.some((j) => j.kind === 'mse' && j.tabId === tabId && j.frameId === frameId && j.status !== 'done');
}

// Sites refuse to be framed via X-Frame-Options / CSP frame-ancestors; strip both, but only
// for frames inside this viewer tab.
async function registerViewer(tabId) {
  const viewers = await getViewers();
  const ruleId = viewers[tabId]?.ruleId ?? newRuleId();
  const frameId = viewers[tabId]?.frameId ?? null;
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
  viewersCache = await update(VIEWERS, (v = {}) => ({ ...v, [tabId]: { ruleId, frameId } }));
  await setCapture(true);
}

async function unregisterViewer(tabId) {
  const viewers = await getViewers();
  if (!(tabId in viewers)) return;
  removeRules([viewers[tabId].ruleId]);
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
//   images  every image of a page, fetched by the offscreen document and saved one by one;
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
      files: job.files,
      ext: item.ext,
      headers: pageHeaders(item.headers),
    },
  });
}

async function downloadFile({ tabId, mediaId, filename }, extra = {}) {
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
    ...extra,
  });
  const start = (h) => chrome.downloads.download({ url: item.url, filename, conflictAction: 'uniquify', headers: h });
  try {
    // A header the downloads API considers unsafe makes it refuse outright; go without them.
    const downloadId = await start(headers).catch(() => start([]));
    await patchJob(job.id, { downloadId });
  } catch (e) {
    await failJob(job.id, e.message);
  }
}

async function startHls({ tabId, mediaId, url, title, tag }, extra = {}) {
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
    ...extra,
  });
  await runInOffscreen(job, item);
  return job;
}

async function startDash({ tabId, mediaId, repId, title, tag }, extra = {}) {
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
    ...extra,
  });
  await runInOffscreen(job, item);
  return job;
}

// All the images the page has shown, into a folder named after it. One queue row for the lot.
async function startImages({ tabId, title }) {
  const { [tabKey(tabId)]: list = [] } = await chrome.storage.session.get(tabKey(tabId));
  const images = list.filter((m) => m.kind === 'image');
  if (!images.length) throw new Error('沒有可下載的圖片');
  const job = await newJob({
    kind: 'images',
    tabId,
    url: await pageUrlOf(tabId),
    title,
    filename: `${title}（${images.length} 張圖片）`,
    files: images.map((m) => ({ url: m.url, filename: imageFilename(title, m.url, m.ext) })),
    identity: await snapshotIdentity(tabId, images[0]),
  });
  await runInOffscreen(job, { headers: {} });
}

// ---- MSE captures -------------------------------------------------------------------
// A capture runs in a frame of its own: the viewer loads the page again, out of sight, and
// the hook there makes that copy's player buffer the whole video (inject/mse-hook.js); its
// content script assembles the tracks and hands back blob: URLs. The page on show can be
// left or changed meanwhile. A couple run at once; the rest wait their turn.

const MAX_CAPTURES = 2;

const toPage = (job, msg) =>
  chrome.tabs.sendMessage(job.tabId, { ...msg, id: job.id }, { frameId: job.frameId ?? 0 }).catch(() => {});

const toViewer = (tabId, msg) => chrome.runtime.sendMessage({ target: 'viewer', tabId, ...msg }).catch(() => {});

async function startMse({ tabId, title }) {
  await startCapture(tabId, title, {});
}

// `fields` carry on an automatic download's record (with its id) or start a new one.
async function startCapture(tabId, title, fields) {
  const { [pageKey(tabId)]: page = {} } = await chrome.storage.session.get(pageKey(tabId));
  if (!/^https?:/.test(page.url || '')) throw new Error('沒有可擷取的網頁');
  const job = {
    kind: 'mse',
    tabId,
    frameId: null,
    url: page.url,
    title,
    filename: filenameFor(title, 'mp4'),
    status: 'queued',
    ...fields,
  };
  if (fields.id) await patchJob(fields.id, job);
  else await newJob(job);
  await nextCaptures();
}

// Starts waiting captures while fewer than MAX_CAPTURES are running.
async function nextCaptures() {
  const { [JOBS]: jobs = [] } = await chrome.storage.session.get(JOBS);
  const busy = jobs.filter((j) => j.kind === 'mse' && ['running', 'paused', 'saving'].includes(j.status)).length;
  const waiting = jobs.filter((j) => j.kind === 'mse' && j.status === 'queued').reverse(); // oldest first
  for (const job of waiting.slice(0, Math.max(0, MAX_CAPTURES - busy))) {
    await patchJob(job.id, { status: 'running' });
    toViewer(job.tabId, { type: 'spawn-capture', id: job.id, url: job.url });
  }
}

// Frames directly under a viewer say who they are (their iframe's name) as each page starts:
// "vd-page" shows the page, "vd-capture:<job id>" runs a capture. A page that renames its
// window is still known by its frame id.
async function onFrameRole(tabId, frameId, { name, url }) {
  const capture = /^vd-capture:(.+)$/.exec(name);
  if (capture) {
    await patchJob(capture[1], { frameId });
    return;
  }
  if (name !== 'vd-page' && frameId !== (await pageFrameOf(tabId))) return;
  viewersCache = await update(VIEWERS, (v = {}) => (v[tabId] ? { ...v, [tabId]: { ...v[tabId], frameId } } : undefined));
  await navigated(tabId, url, frameId);
}

async function onFrameLoaded(tabId, frameId) {
  await update(JOBS, () => undefined); // after any pending write (the frame id may be on its way)
  const job = await findJob((j) => j.kind === 'mse' && j.tabId === tabId && j.frameId === frameId && !j.started);
  if (!job) return;
  await patchJob(job.id, { started: true });
  toPage(job, { type: 'mse-capture', source: null });
}

// ---- Automatic mode -----------------------------------------------------------------
// Fastest first: what the network showed (the best HLS/DASH quality, else the largest
// file), then an MSE capture of the page's player if that is missing or fails. One queue
// row follows whichever method is running.

function bestNetworkMedia(list) {
  const shown = list.filter((m) => !m.parent && m.probed !== false && !m.error);
  const streams = [];
  for (const m of shown) {
    if (m.kind === 'hls' && m.probed) {
      const v = m.variants?.[0];
      if (v) streams.push({ height: v.height || 0, start: (extra) => startHlsWithAudio(m, v, extra) });
      else if (!m.live && (!m.encryption || m.encryption === 'AES-128')) {
        streams.push({ height: 0, start: (extra) => startHls({ tabId: extra.tabId, mediaId: m.id, url: m.url, title: extra.title, tag: '' }, extra.fields) });
      }
    } else if (m.kind === 'dash' && m.probed && !m.live) {
      const video = m.reps.find((r) => r.kind === 'video' && !r.protected);
      const audio = m.reps.find((r) => r.kind === 'audio' && !r.protected);
      const main = video || audio;
      if (main) streams.push({ height: video?.height || 0, start: (extra) => startDashWithAudio(m, main, video && audio, extra) });
    }
  }
  streams.sort((a, b) => b.height - a.height);
  if (streams.length) return { method: '串流', start: streams[0].start };
  // A page playing through MSE assembles its video from pieces; the .mp4 files it fetched are
  // those pieces, not the video. Leave it to the capture.
  if (list.some((m) => m.kind === 'mse')) return null;
  const file = shown.filter((m) => m.kind === 'file').sort((a, b) => (b.size || 0) - (a.size || 0))[0];
  if (!file) return null;
  return {
    method: '檔案',
    start: (extra) => downloadFile({ tabId: extra.tabId, mediaId: file.id, filename: filenameFor(extra.title, file.ext) }, extra.fields),
  };
}

// A video playlist and, when its sound is separate, the audio alongside: a companion job
// that goes away if the video falls back to a capture (which has the sound).
async function startHlsWithAudio(m, v, { tabId, title, fields }) {
  const audio = audioFor(v, m.audio);
  const job = await startHls({ tabId, mediaId: m.id, url: v.url, title, tag: variantLabel(v) }, fields);
  if (audio) {
    const tag = `音訊${audio.language ? ` ${audio.language}` : ''}`;
    await startHls({ tabId, mediaId: m.id, url: audio.url, title, tag }, { companionOf: job.id });
  }
}

async function startDashWithAudio(m, main, audio, { tabId, title, fields }) {
  const job = await startDash({ tabId, mediaId: m.id, repId: main.id, title, tag: repLabel(main) }, fields);
  if (audio) await startDash({ tabId, mediaId: m.id, repId: audio.id, title, tag: repLabel(audio) }, { companionOf: job.id });
}

async function startAuto({ tabId, title }) {
  const { [tabKey(tabId)]: list = [] } = await chrome.storage.session.get(tabKey(tabId));
  const network = bestNetworkMedia(list);
  if (!network) return startCapture(tabId, title, { auto: [], method: '緩存' });
  await network.start({ tabId, title, fields: { auto: ['mse'], method: network.method } });
}

// A failed download of an automatic job moves on to the next method, in the same row.
async function failJob(id, error) {
  const job = await findJob((j) => j.id === id);
  if (!job) return;
  if (!job.auto?.length) {
    await patchJob(id, { status: 'failed', error });
    return;
  }
  finishJob(job);
  const { [JOBS]: jobs = [] } = await chrome.storage.session.get(JOBS);
  for (const companion of jobs.filter((j) => j.companionOf === id)) deleteJob(companion.id);
  const [next, ...rest] = job.auto;
  if (next === 'mse') {
    await startCapture(job.tabId, job.title, {
      id,
      auto: rest,
      method: '緩存',
      done: 0,
      total: 0,
      bytes: 0,
      downloadId: null,
      rules: null,
      error: null,
      tried: [...(job.tried || []), `${job.method}：${error}`],
    });
  }
}

// Saves the assembled files. Replies with the ones the downloads API refused, for the page
// to save itself.
async function onMseReady({ id, files, title: pageTitle }) {
  const job = await findJob((j) => j.id === id);
  if (!job) return {};
  // Started before the page had reported its title (named after the host)? The capture's
  // copy of the page knows it.
  const host = /^https?:/.test(job.url || '') ? new URL(job.url).hostname : '';
  const title = job.title === host && pageTitle ? pageTitle : job.title;
  const named = files.map((f) => ({ ...f, filename: filenameFor(title, f.ext, f.label) }));
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

async function onJobReady({ id, blobUrl, ext, size, files, failed }) {
  const job = await findJob((j) => j.id === id);
  // Deleted while it was finishing: just let go of the blob.
  if (!job) return void toOffscreen({ type: 'release', id });
  if (files) return onImagesReady(job, files, failed);
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

// Saves each fetched image; the job is done once every one of those downloads has ended.
async function onImagesReady(job, files, failed) {
  await patchJob(job.id, { status: 'saving', bytes: files.reduce((n, f) => n + f.size, 0), failedCount: failed });
  const ids = [];
  let refused = 0;
  for (const f of files) {
    try {
      ids.push(await chrome.downloads.download({ url: f.blobUrl, filename: f.filename, conflictAction: 'uniquify' }));
    } catch {
      refused++;
    }
  }
  await patchJob(job.id, { downloadIds: ids, downloadId: ids[0] ?? null, failedCount: failed + refused });
  await settleImages(job.id);
}

// Finishes an image job once none of its downloads is still in progress.
async function settleImages(id) {
  const job = await findJob((j) => j.id === id);
  if (job?.status !== 'saving' || !job.downloadIds) return;
  const found = await Promise.all(job.downloadIds.map((d) => chrome.downloads.search({ id: d })));
  const states = found.map((r) => r[0]?.state);
  if (states.includes('in_progress')) return;
  const lost = states.filter((s) => s !== 'complete').length;
  const saved = states.length - lost;
  let settled = false;
  await update(JOBS, (jobs = []) =>
    jobs.map((j) => {
      if (j.id !== id || j.status !== 'saving') return j;
      settled = true;
      const failedCount = job.failedCount + lost;
      return saved ? { ...j, status: 'done', failedCount } : { ...j, status: 'failed', error: '圖片都無法存檔', failedCount };
    }),
  );
  if (settled) finishJob(job);
}

// Drops the job's header rules and blob; closes the offscreen document when idle.
async function finishJob(job) {
  const latest = (await findJob((j) => j.id === job.id)) || job;
  removeRules(Object.values(latest.rules || {}));
  if (job.kind === 'mse') {
    toViewer(job.tabId, { type: 'drop-capture', id: job.id });
    nextCaptures();
  } else {
    toOffscreen({ type: 'release', id: job.id });
  }
  const { [JOBS]: jobs = [] } = await chrome.storage.session.get(JOBS);
  const busy = jobs.some((j) => ['file', 'hls', 'dash', 'images'].includes(j.kind) && ['running', 'paused', 'saving'].includes(j.status));
  if (!busy) chrome.offscreen.closeDocument().catch(() => {});
}

async function onJobFailed({ id, cancelled, error }) {
  const job = await findJob((j) => j.id === id);
  if (!job) return;
  if (cancelled) {
    await patchJob(id, { status: 'cancelled' });
    finishJob(job);
  } else if (job.auto?.length) {
    await failJob(id, error);
  } else {
    await patchJob(id, { status: 'failed', error });
    finishJob(job);
  }
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
  for (const d of job.downloadIds || (job.downloadId != null ? [job.downloadId] : [])) {
    await chrome.downloads.cancel(d).catch(() => {});
    chrome.downloads.erase({ id: d }).catch(() => {});
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
  const owns = (j) => j.downloadId === delta.id || j.downloadIds?.includes(delta.id);
  let job = await findJob(owns);
  // A fast refusal can arrive before downloadFile() has stored the download id.
  if (!job && state === 'interrupted') {
    await sleep(300);
    job = await findJob(owns);
  }
  if (!job || job.status === 'cancelled') return;
  // An image that failed to save is counted, not a reason to stop the rest.
  if (job.kind === 'images') return void settleImages(job.id);
  if (state === 'complete') {
    await patchJob(job.id, { status: 'done' });
  } else if (job.kind === 'native' && /^SERVER_/.test(delta.error?.current || '')) {
    chrome.downloads.erase({ id: delta.id }).catch(() => {});
    retryAsPage(job).catch((e) => failJob(job.id, e.message));
    return;
  } else {
    await failJob(job.id, delta.error?.current || '存檔被中斷');
    return;
  }
  if (job.kind !== 'native') finishJob(job);
});

// ---- Wiring ---------------------------------------------------------------------------

chrome.action.onClicked.addListener(openViewer);

const MEDIA_FILTER = { urls: ['http://*/*', 'https://*/*'], types: ['media', 'image', 'xmlhttprequest', 'object', 'other'] };

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
    if (!hit) return;
    inOrder(d.tabId, async () => {
      if (await isCaptureFrame(d.tabId, d.frameId)) return;
      // Images keep no headers: there can be hundreds, and the tab's identity has their hosts.
      await addMedia(d.tabId, { url: d.url, ...hit, size, headers: hit.kind === 'image' ? undefined : sent, frameId: d.frameId });
    });
  },
  MEDIA_FILTER,
  ['responseHeaders'],
);

// In a viewer the page lives in the frame directly under the viewer page.
// (In a viewer, the framed page reports its own navigations: see onFrameRole.)
chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId === 0 && !(await isViewer(d.tabId))) navigated(d.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabTasks.delete(tabId);
  // Captures run in frames of the viewer: closing it ends them.
  update(JOBS, (jobs = []) =>
    jobs.map((j) =>
      j.kind === 'mse' && j.tabId === tabId && ['queued', 'running', 'paused'].includes(j.status)
        ? { ...j, status: 'failed', error: '小視窗已關閉' }
        : j,
    ),
  );
  chrome.storage.session.remove([tabKey(tabId), pageKey(tabId), idsKey(tabId)]);
  for (const key of [tabKey(tabId), pageKey(tabId)]) chains.delete(key);
  identities.delete(tabId);
  unregisterViewer(tabId);
});

// <video>/<audio> sources the page's content script found.
async function addDomMedia(tabId, frameId, urls) {
  for (const url of urls) {
    // A <video src> without a recognizable extension is still a video.
    const hit = classify(url, '', null) ?? (urlExt(url) ? null : { kind: 'file', ext: 'mp4' });
    if (hit) await addMedia(tabId, { url, ...hit, size: null, frameId });
  }
}

// <img> images the content script found, with their dimensions. The page says it is an image
// whatever the URL looks like; only the type is a guess until the network shows it.
async function addDomImages(tabId, frameId, images) {
  for (const { url, width, height } of images) {
    if (urlExt(url) === 'svg') continue;
    const hit = classify(url, '', null);
    const ext = hit?.kind === 'image' ? hit.ext : 'jpg';
    await addMedia(tabId, { url, kind: 'image', ext, size: null, width, height, frameId });
  }
}

// SourceBuffers the MSE hook saw: one item per track, grouped by player (source) in the viewer.
async function addPlayers(tabId, frameId, streams) {
  for (const st of streams) {
    await addMedia(tabId, {
      url: `mse:${frameId}:${st.id}`,
      kind: 'mse',
      mime: String(st.mime),
      size: Number(st.bytes) || 0,
      truncated: !!st.truncated,
      frameId,
      streamId: st.id,
      source: st.source,
    });
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target === 'offscreen') return;
  switch (msg.type) {
    case 'viewer-open':
      registerViewer(sender.tab.id).then(() => reply(true), (e) => reply({ error: e.message }));
      return true;
    case 'frame-role':
      if (sender.tab) {
        inOrder(sender.tab.id, async () => {
          if (await isViewer(sender.tab.id)) await onFrameRole(sender.tab.id, sender.frameId, msg);
        });
      }
      return;
    case 'frame-loaded':
      if (sender.tab) onFrameLoaded(sender.tab.id, sender.frameId);
      return;
    case 'page-title': {
      const tabId = sender.tab?.id;
      if (tabId == null) return;
      inOrder(tabId, async () => {
        if ((await pageFrameOf(tabId)) === sender.frameId) {
          await update(pageKey(tabId), (p = {}) =>
            p.url === msg.url ? { ...p, title: msg.title } : { ...p, early: { url: msg.url, title: msg.title } },
          );
        }
      });
      return;
    }
    case 'dom-media':
    case 'dom-images':
    case 'mse-streams': {
      const tabId = sender.tab?.id;
      if (tabId == null) return;
      // A capture frame's copy of the page is not what the viewer shows.
      inOrder(tabId, async () => {
        if (await isCaptureFrame(tabId, sender.frameId)) return;
        if (msg.type === 'dom-media') await addDomMedia(tabId, sender.frameId, msg.urls);
        else if (msg.type === 'dom-images') await addDomImages(tabId, sender.frameId, msg.images);
        else await addPlayers(tabId, sender.frameId, msg.streams);
      });
      return;
    }
    case 'download-auto':
      startAuto(msg).then(() => reply({ ok: true }), (e) => reply({ error: e.message }));
      return true;
    case 'download-mse':
      startMse(msg).then(() => reply({ ok: true }), (e) => reply({ error: e.message }));
      return true;
    case 'mse-ready':
      onMseReady(msg).then(reply, () => reply({}));
      return true;
    case 'download':
      downloadFile(msg).then(() => reply({ ok: true }), (e) => reply({ error: e.message }));
      return true;
    case 'download-images':
      startImages(msg).then(() => reply({ ok: true }), (e) => reply({ error: e.message }));
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
