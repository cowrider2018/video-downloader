import { audioFor, variantLabel } from '../lib/hls.js';
import { displayName, filenameFor, formatBytes } from '../lib/media.js';

const addr = document.getElementById('addr');
const list = document.getElementById('media');

const send = (msg) => chrome.runtime.sendMessage(msg);

let trackedId = null; // the browser tab being followed
let page = {}; // { url, title } of that tab
let media = [];
let jobs = [];
const fileDownloads = new Map(); // url -> Chrome download id, for files started from here
let editing = false; // the user is typing; don't overwrite the address bar

// ---- Address bar ----------------------------------------------------------------------

function normalize(input) {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

// Navigates the followed tab; the page itself always runs in a real browser tab.
async function load(url) {
  addr.value = url;
  const tab = trackedId != null && (await chrome.tabs.get(trackedId).catch(() => null));
  if (tab) chrome.tabs.update(tab.id, { url });
  else chrome.tabs.create({ url });
}

document.getElementById('bar').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = normalize(addr.value);
  if (!url) return;
  editing = false;
  load(url);
  addr.blur();
});

addr.addEventListener('focus', () => addr.select());
addr.addEventListener('input', () => (editing = true));
addr.addEventListener('blur', () => {
  editing = false;
  addr.value = page.url || '';
});

// ---- Media rows -----------------------------------------------------------------------
// One row per downloadable file; a master playlist contributes one row per quality.

const jobFor = (url) => jobs.find((j) => j.url === url);

function titleForFiles() {
  if (page.title) return page.title;
  try {
    return new URL(page.url).hostname;
  } catch {
    return 'video';
  }
}

function formatDuration(sec) {
  if (!sec) return '';
  const s = Math.round(sec);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

async function startHls(url, tag, audio) {
  const base = { type: 'download-hls', title: titleForFiles(), referer: page.url };
  await send({ ...base, url, tag });
  if (audio) await send({ ...base, url: audio.url, tag: `音訊${audio.language ? ` ${audio.language}` : ''}` });
}

// Button state for an HLS row follows its most recent job.
function hlsButton(url, start) {
  const job = jobFor(url);
  switch (job?.status) {
    case 'running': {
      const pct = job.total ? Math.floor((job.done / job.total) * 100) : 0;
      return { text: `${pct}%`, title: '點擊取消', onClick: () => send({ type: 'cancel-job', id: job.id }) };
    }
    case 'saving':
      return { text: '存檔中', disabled: true };
    case 'done':
      return { text: '顯示', title: job.filename, onClick: () => chrome.downloads.show(job.downloadId) };
    case 'failed':
      return { text: '重試', title: job.error, error: true, onClick: start };
    default:
      return { text: '下載', onClick: start };
  }
}

function fileButton(m) {
  const id = fileDownloads.get(m.url);
  if (id != null) return { text: '顯示', onClick: () => chrome.downloads.show(id) };
  return {
    text: '下載',
    onClick: async () => {
      const res = await send({ type: 'download', url: m.url, filename: filenameFor(titleForFiles(), m.ext) });
      if (res?.id != null) fileDownloads.set(m.url, res.id);
      render();
    },
  };
}

function rowsFor(m) {
  const name = displayName(m.url);
  if (m.kind === 'file') {
    return [{ key: m.url, name, title: m.url, meta: [m.ext.toUpperCase(), formatBytes(m.size)], button: fileButton(m) }];
  }
  const off = (text, title) => ({ text, title, disabled: true });
  if (!m.probed) return [{ key: m.url, name, title: m.url, meta: ['HLS'], button: off('解析中') }];
  if (m.error) return [{ key: m.url, name, title: m.url, meta: ['HLS'], button: off('無法解析', m.error) }];
  if (m.variants) {
    return m.variants.map((v) => ({
      key: v.url,
      name,
      title: v.url,
      meta: ['HLS', variantLabel(v), v.bandwidth ? `${(v.bandwidth / 1e6).toFixed(1)} Mbps` : ''],
      button: hlsButton(v.url, () => startHls(v.url, variantLabel(v), audioFor(v, m.audio))),
    }));
  }
  const meta = ['HLS', formatDuration(m.duration)];
  if (m.live) return [{ key: m.url, name, title: m.url, meta, button: off('直播', '不支援直播串流') }];
  if (m.encryption && m.encryption !== 'AES-128') {
    return [{ key: m.url, name, title: m.url, meta, button: off('受保護', `${m.encryption} 加密不支援`) }];
  }
  return [{ key: m.url, name, title: m.url, meta, button: hlsButton(m.url, () => startHls(m.url, '', null)) }];
}

// Rows are reused by key, so a progress update never swaps a button out from under the cursor.
const rowEls = new Map();

function rowEl(key) {
  let el = rowEls.get(key);
  if (!el) {
    const li = document.createElement('li');
    const name = li.appendChild(document.createElement('span'));
    name.className = 'name';
    const meta = li.appendChild(document.createElement('span'));
    meta.className = 'meta';
    const button = li.appendChild(document.createElement('button'));
    el = { li, name, meta, button };
    rowEls.set(key, el);
  }
  return el;
}

const emptyRow = document.createElement('li');
emptyRow.className = 'empty';
emptyRow.textContent = '尚未偵測到媒體';

function render() {
  const rows = media.filter((m) => !m.parent).flatMap(rowsFor);
  const items = rows.map((r) => {
    const el = rowEl(r.key);
    el.name.textContent = r.name;
    el.name.title = r.title;
    el.meta.textContent = r.meta.filter(Boolean).join(' · ');
    el.button.textContent = r.button.text;
    el.button.title = r.button.title || '';
    el.button.disabled = !!r.button.disabled;
    el.button.className = r.button.error ? 'error' : '';
    el.button.onclick = r.button.onClick || null;
    return el.li;
  });
  const keys = new Set(rows.map((r) => r.key));
  for (const key of rowEls.keys()) if (!keys.has(key)) rowEls.delete(key);

  const next = items.length ? items : [emptyRow];
  const same = next.length === list.children.length && next.every((li, i) => list.children[i] === li);
  if (!same) list.replaceChildren(...next);
}

function applyPage(tab) {
  page = tab ? { url: tab.url || '', title: tab.title || '' } : {};
  document.title = page.title || 'Video Downloader';
  if (!editing) addr.value = page.url || '';
}

const mediaKey = () => `tab:${trackedId}`;

async function follow(tabId) {
  trackedId = tabId ?? null;
  const key = mediaKey();
  const stored = await chrome.storage.session.get(key);
  media = stored[key] || [];
  applyPage(trackedId != null ? await chrome.tabs.get(trackedId).catch(() => null) : null);
  render();
}

// ---- Startup --------------------------------------------------------------------------

const stored = await chrome.storage.session.get(['tracked', 'jobs']);
jobs = stored.jobs || [];
await follow(stored.tracked);
if (!page.url) addr.focus();

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.tracked) return void follow(changes.tracked.newValue);
  if (changes[mediaKey()]) media = changes[mediaKey()].newValue || [];
  if (changes.jobs) jobs = changes.jobs.newValue || [];
  if (changes[mediaKey()] || changes.jobs) render();
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tabId === trackedId && (info.url || info.title)) applyPage(tab);
});
