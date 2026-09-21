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

async function startHls(m, url, tag, audio) {
  const base = { type: 'download-hls', tabId: trackedId, mediaId: m.id, title: titleForFiles() };
  await send({ ...base, url, tag });
  if (audio) await send({ ...base, url: audio.url, tag: `音訊${audio.language ? ` ${audio.language}` : ''}` });
}

// Button state for a row with a download job (HLS, or a file fetched in the page) follows
// its most recent job.
function jobButton(url, start) {
  const job = jobFor(url);
  switch (job?.status) {
    case 'running': {
      const text = job.total ? `${Math.floor((job.done / job.total) * 100)}%` : formatBytes(job.bytes) || '0%';
      return { text, title: '點擊取消', onClick: () => send({ type: 'cancel-job', id: job.id }) };
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
  // The server refused the plain download and the page is fetching it instead.
  if (jobFor(m.url)) return jobButton(m.url, () => fileStart(m));
  const id = fileDownloads.get(m.url);
  if (id != null) return { text: '顯示', onClick: () => chrome.downloads.show(id) };
  return { text: '下載', onClick: () => fileStart(m) };
}

async function fileStart(m) {
  const res = await send({
    type: 'download',
    tabId: trackedId,
    mediaId: m.id,
    filename: filenameFor(titleForFiles(), m.ext),
  });
  if (res?.id != null) fileDownloads.set(m.url, res.id);
  render();
}

// MSE captures are saved by the page itself, so there is no download id to track; the
// button just acknowledges for a moment (the capture may keep growing and can be saved again).
const mseSavedAt = new Map();

function mseExt(mime) {
  const type = mime.split(';')[0].trim();
  if (type === 'audio/mp4') return 'm4a';
  if (type === 'audio/webm') return 'weba';
  if (type.endsWith('/webm')) return 'webm';
  return 'mp4';
}

function mseRow(m) {
  const audio = m.mime.startsWith('audio/');
  const codec = m.mime.match(/codecs="?([^",]+)/)?.[1] || m.mime.split(';')[0];
  const label = audio ? '音訊' : '影像';
  const saved = Date.now() - (mseSavedAt.get(m.url) || 0) < 3000;
  return {
    key: m.url,
    name: `緩存${label} (${codec})`,
    title: m.mime,
    meta: ['MSE', formatBytes(m.size), m.truncated ? '已達上限' : ''],
    button: saved
      ? { text: '已存', disabled: true }
      : {
          text: '下載',
          disabled: !m.size,
          onClick: () => {
            send({
              type: 'save-mse',
              tabId: trackedId,
              frameId: m.frameId,
              streamId: m.streamId,
              filename: filenameFor(titleForFiles(), mseExt(m.mime), label),
            });
            mseSavedAt.set(m.url, Date.now());
            render();
            setTimeout(render, 3000);
          },
        },
  };
}

function rowsFor(m) {
  if (m.kind === 'mse') return [mseRow(m)];
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
      button: jobButton(v.url, () => startHls(m, v.url, variantLabel(v), audioFor(v, m.audio))),
    }));
  }
  const meta = ['HLS', formatDuration(m.duration)];
  if (m.live) return [{ key: m.url, name, title: m.url, meta, button: off('直播', '不支援直播串流') }];
  if (m.encryption && m.encryption !== 'AES-128') {
    return [{ key: m.url, name, title: m.url, meta, button: off('受保護', `${m.encryption} 加密不支援`) }];
  }
  return [{ key: m.url, name, title: m.url, meta, button: jobButton(m.url, () => startHls(m, m.url, '', null)) }];
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

// Switching tabs quickly starts overlapping follows; only the latest may apply its results.
let followSeq = 0;

async function follow(tabId) {
  const seq = ++followSeq;
  trackedId = tabId ?? null;
  const key = mediaKey();
  const [stored, tab] = await Promise.all([
    chrome.storage.session.get(key),
    trackedId != null ? chrome.tabs.get(trackedId).catch(() => null) : null,
  ]);
  if (seq !== followSeq) return;
  media = stored[key] || [];
  applyPage(tab);
  render();
}

// ---- Startup --------------------------------------------------------------------------

await send({ type: 'capture-on' });

// Listen before the first read so nothing that changes in between is missed.
chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.jobs) jobs = changes.jobs.newValue || [];
  if (changes.tracked) return void follow(changes.tracked.newValue);
  if (changes[mediaKey()]) media = changes[mediaKey()].newValue || [];
  if (changes[mediaKey()] || changes.jobs) render();
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tabId === trackedId && (info.url || info.title)) applyPage(tab);
});

const stored = await chrome.storage.session.get(['tracked', 'jobs']);
jobs = stored.jobs || [];
if (!followSeq) await follow(stored.tracked);
if (!page.url) addr.focus();
