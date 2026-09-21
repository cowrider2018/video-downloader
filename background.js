import { parsePlaylist } from './lib/hls.js';
import { classify, filenameFor, sizeFromHeaders, urlExt } from './lib/media.js';

// Detected media lives in storage.session under `tab:<id>`, download jobs under `jobs`,
// because the service worker can be torn down at any moment and in-memory state would
// be lost with it.
const tabKey = (tabId) => `tab:${tabId}`;
const JOBS = 'jobs';

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

function setBadge(tabId, list = []) {
  const n = list.filter((m) => !m.parent).length;
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' }).catch(() => {});
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
  const list = await update(tabKey(tabId), (list = []) => {
    const old = list.find((m) => m.url === item.url);
    if (!old) {
      added = { id: crypto.randomUUID(), detectedAt: Date.now(), ...item };
      return linkChildren([...list, added]);
    }
    if (old.size == null && item.size != null) {
      return list.map((m) => (m === old ? { ...m, size: item.size } : m));
    }
  });
  setBadge(tabId, list);
  if (added?.kind === 'hls') probe(tabId, added);
}

async function clearTab(tabId) {
  await update(tabKey(tabId), () => []);
  setBadge(tabId);
}

// ---- Referer rules --------------------------------------------------------------------
// Requests made by the extension itself (tabId -1) get the page's Referer and Origin,
// scoped to the hosts one probe or job actually needs.

const newRuleId = () => 1 + Math.floor(Math.random() * 0x7ffffffe);

async function setRefererRule(ruleId, hosts, referer) {
  if (!/^https?:/i.test(referer || '')) return;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [
      {
        id: ruleId,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'referer', operation: 'set', value: referer },
            { header: 'origin', operation: 'set', value: new URL(referer).origin },
          ],
        },
        condition: {
          requestDomains: hosts,
          tabIds: [chrome.tabs.TAB_ID_NONE],
          resourceTypes: ['xmlhttprequest', 'other'],
        },
      },
    ],
  });
}

const removeRule = (ruleId) =>
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] }).catch(() => {});

// ---- HLS probing ----------------------------------------------------------------------
// Fetches a freshly detected playlist so the popup can show qualities, length and
// whether the stream is downloadable at all.

async function probe(tabId, item) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const ruleId = newRuleId();
  let info;
  try {
    await setRefererRule(ruleId, [new URL(item.url).hostname], tab?.url);
    const res = await fetch(item.url, { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const pl = parsePlaylist(await res.text(), res.url || item.url);
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
  } finally {
    removeRule(ruleId);
  }
  const list = await update(tabKey(tabId), (list = []) =>
    linkChildren(list.map((m) => (m.id === item.id ? { ...m, ...info, probed: true } : m))),
  );
  setBadge(tabId, list);
}

// ---- HLS jobs -------------------------------------------------------------------------

let creatingOffscreen = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Assemble HLS segments into a single file for download.',
    })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

const toOffscreen = (msg) => chrome.runtime.sendMessage({ target: 'offscreen', ...msg }).catch(() => {});

const patchJob = (id, patch) =>
  update(JOBS, (jobs = []) => jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)));

async function startHls({ url, title, tag, referer }) {
  const job = {
    id: crypto.randomUUID(),
    ruleId: newRuleId(),
    url,
    title,
    tag,
    referer,
    filename: filenameFor(title, 'ts', tag),
    status: 'running',
    done: 0,
    total: 0,
    bytes: 0,
    startedAt: Date.now(),
  };
  await update(JOBS, (jobs = []) => [job, ...jobs]);
  await ensureOffscreen();
  toOffscreen({ type: 'hls-start', job });
}

// Frees the assembled blob; closes the offscreen document once nothing else needs it.
async function finishJob(job) {
  removeRule(job.ruleId);
  toOffscreen({ type: 'release', id: job.id });
  const { [JOBS]: jobs = [] } = await chrome.storage.session.get(JOBS);
  if (!jobs.some((j) => j.status === 'running' || j.status === 'saving')) {
    chrome.offscreen.closeDocument().catch(() => {});
  }
}

async function onJobReady({ id, blobUrl, ext, size }) {
  const { [JOBS]: jobs = [] } = await chrome.storage.session.get(JOBS);
  const job = jobs.find((j) => j.id === id);
  if (!job) return;
  const filename = filenameFor(job.title, ext, job.tag);
  removeRule(job.ruleId);
  try {
    const downloadId = await chrome.downloads.download({ url: blobUrl, filename, conflictAction: 'uniquify' });
    await patchJob(id, { status: 'saving', filename, bytes: size, downloadId });
  } catch (e) {
    await patchJob(id, { status: 'failed', error: e.message });
    finishJob(job);
  }
}

async function onJobFailed({ id, cancelled, error }) {
  const jobs = await patchJob(id, cancelled ? { status: 'cancelled' } : { status: 'failed', error });
  const job = jobs.find((j) => j.id === id);
  if (job) finishJob(job);
}

async function cancelJob(id) {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) toOffscreen({ type: 'cancel', id });
  // Without an offscreen document the job can't still be running; just mark it.
  else await patchJob(id, { status: 'cancelled' });
}

chrome.downloads.onChanged.addListener(async (delta) => {
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  const { [JOBS]: jobs = [] } = await chrome.storage.session.get(JOBS);
  const job = jobs.find((j) => j.downloadId === delta.id);
  if (!job) return;
  await patchJob(job.id, state === 'complete' ? { status: 'done' } : { status: 'failed', error: '存檔被中斷' });
  finishJob(job);
});

// ---- Wiring ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#1a1615' });
});

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || d.statusCode < 200 || d.statusCode >= 300) return;
    const headers = {};
    for (const { name, value } of d.responseHeaders || []) headers[name.toLowerCase()] = value;
    const size = sizeFromHeaders(headers);
    const hit = classify(d.url, headers['content-type'], size);
    if (hit) addMedia(d.tabId, { url: d.url, ...hit, size });
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'object', 'other'] },
  ['responseHeaders'],
);

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) clearTab(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(tabKey(tabId));
  chains.delete(tabKey(tabId));
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.target === 'offscreen') return;
  switch (msg.type) {
    case 'dom-media': {
      const tabId = sender.tab?.id;
      if (tabId == null) return;
      for (const url of msg.urls) {
        // A <video src> without a recognizable extension is still a video.
        const hit = classify(url, '', null) ?? (urlExt(url) ? null : { kind: 'file', ext: 'mp4' });
        if (hit) addMedia(tabId, { url, ...hit, size: null });
      }
      return;
    }
    case 'download':
      chrome.downloads
        .download({ url: msg.url, filename: msg.filename, conflictAction: 'uniquify' })
        .then((id) => reply({ id }), (e) => reply({ error: e.message }));
      return true;
    case 'download-hls':
      startHls(msg).then(() => reply({ ok: true }), (e) => reply({ error: e.message }));
      return true;
    case 'cancel-job':
      cancelJob(msg.id);
      return;
    case 'remove-job':
      update(JOBS, (jobs = []) => jobs.filter((j) => j.id !== msg.id));
      return;
    case 'set-referer':
      setRefererRule(msg.ruleId, msg.hosts, msg.referer).then(
        () => reply(true),
        (e) => reply({ error: e.message }),
      );
      return true;
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
      onJobReady(msg);
      return;
    case 'job-failed':
      onJobFailed(msg);
      return;
  }
});
