import { audioFor, variantLabel } from '../lib/hls.js';
import { displayName, filenameFor, formatBytes } from '../lib/media.js';

const tab = await chrome.tabs.getCurrent();
const mediaKey = `tab:${tab.id}`;
const pageKey = `page:${tab.id}`;

const addr = document.getElementById('addr');
const frame = document.getElementById('frame');
const mediaList = document.getElementById('media');
const jobList = document.getElementById('jobs');

const send = (msg) => chrome.runtime.sendMessage(msg);

let page = {}; // { url, title } of the framed page
let media = [];
let jobs = [];
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

function load(url) {
  frame.src = url;
  addr.value = url;
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
  if (page.url) addr.value = page.url;
});

function applyPage(p = {}) {
  page = p;
  document.title = page.title || 'Video Downloader';
  if (!editing && page.url) addr.value = page.url;
}

// ---- Rows -----------------------------------------------------------------------------
// Both lists reuse row elements by key, so a progress update never swaps a button out from
// under the cursor.

function makeRenderer(list, emptyText) {
  const rows = new Map();
  const empty = document.createElement('li');
  empty.className = 'empty';
  empty.textContent = emptyText;

  function rowEl(key) {
    let el = rows.get(key);
    if (!el) {
      const li = document.createElement('li');
      const name = li.appendChild(document.createElement('span'));
      name.className = 'name';
      const meta = li.appendChild(document.createElement('span'));
      meta.className = 'meta';
      el = { li, name, meta, buttons: [] };
      rows.set(key, el);
    }
    return el;
  }

  function setButtons(el, specs) {
    while (el.buttons.length < specs.length) el.buttons.push(el.li.appendChild(document.createElement('button')));
    while (el.buttons.length > specs.length) el.buttons.pop().remove();
    specs.forEach((b, i) => {
      const btn = el.buttons[i];
      btn.textContent = b.text;
      btn.title = b.title || '';
      btn.disabled = !!b.disabled;
      btn.className = b.error ? 'error' : '';
      btn.onclick = b.onClick || null;
    });
  }

  return (specs) => {
    const items = specs.map((r) => {
      const el = rowEl(r.key);
      el.name.textContent = r.name;
      el.name.title = r.title || r.name;
      el.meta.textContent = r.meta.filter(Boolean).join(' · ');
      el.meta.className = r.metaError ? 'meta error' : 'meta';
      setButtons(el, r.buttons);
      return el.li;
    });
    const keys = new Set(specs.map((r) => r.key));
    for (const key of rows.keys()) if (!keys.has(key)) rows.delete(key);
    const next = items.length || !emptyText ? items : [empty];
    const same = next.length === list.children.length && next.every((li, i) => list.children[i] === li);
    if (!same) list.replaceChildren(...next);
  };
}

// ---- Detected media -------------------------------------------------------------------
// One row per downloadable file; a master playlist contributes one row per quality.

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

// A row's button says "已加入" for a moment after it queued something.
const queuedAt = new Map();

function queueButton(key, start) {
  const left = 1500 - (Date.now() - (queuedAt.get(key) || 0));
  if (left > 0) {
    // Whichever render shows the notice also takes it down; a row rebuilt later (after
    // navigating back) would otherwise keep it until something else re-renders.
    setTimeout(renderMedia, left + 50);
    return { text: '已加入', disabled: true };
  }
  return {
    text: '下載',
    onClick: async () => {
      queuedAt.set(key, Date.now());
      renderMedia();
      const res = await start();
      if (res?.error) alert(res.error);
    },
  };
}

function startHls(m, url, tag, audio) {
  const base = { type: 'download-hls', tabId: tab.id, mediaId: m.id, title: titleForFiles() };
  const video = send({ ...base, url, tag });
  if (audio) send({ ...base, url: audio.url, tag: `音訊${audio.language ? ` ${audio.language}` : ''}` });
  return video;
}

function mseExt(mime) {
  const type = mime.split(';')[0].trim();
  if (type === 'audio/mp4') return 'm4a';
  if (type === 'audio/webm') return 'weba';
  if (type.endsWith('/webm')) return 'webm';
  return 'mp4';
}

// MSE captures are saved by the page itself (the data only exists there).
function mseRow(m) {
  const label = m.mime.startsWith('audio/') ? '音訊' : '影像';
  const codec = m.mime.match(/codecs="?([^",]+)/)?.[1] || m.mime.split(';')[0];
  const button = queueButton(m.url, () =>
    send({
      type: 'save-mse',
      tabId: tab.id,
      frameId: m.frameId,
      streamId: m.streamId,
      filename: filenameFor(titleForFiles(), mseExt(m.mime), label),
    }),
  );
  if (!m.size) button.disabled = true;
  return {
    key: m.url,
    name: `緩存${label} (${codec})`,
    title: m.mime,
    meta: ['MSE', formatBytes(m.size), m.truncated ? '已達上限' : ''],
    buttons: [button],
  };
}

function rowsFor(m) {
  if (m.kind === 'mse') return [mseRow(m)];
  const name = displayName(m.url);
  const row = (key, meta, button) => ({ key, name, title: key, meta, buttons: [button] });
  const off = (text, title) => ({ text, title, disabled: true });
  if (m.kind === 'file') {
    const start = () =>
      send({ type: 'download', tabId: tab.id, mediaId: m.id, filename: filenameFor(titleForFiles(), m.ext) });
    return [row(m.url, [m.ext.toUpperCase(), formatBytes(m.size)], queueButton(m.url, start))];
  }
  if (!m.probed) return [row(m.url, ['HLS'], off('解析中'))];
  if (m.error) return [row(m.url, ['HLS'], off('無法解析', m.error))];
  if (m.variants) {
    return m.variants.map((v) =>
      row(
        v.url,
        ['HLS', variantLabel(v), v.bandwidth ? `${(v.bandwidth / 1e6).toFixed(1)} Mbps` : ''],
        queueButton(v.url, () => startHls(m, v.url, variantLabel(v), audioFor(v, m.audio))),
      ),
    );
  }
  const meta = ['HLS', formatDuration(m.duration)];
  if (m.live) return [row(m.url, meta, off('直播', '不支援直播串流'))];
  if (m.encryption && m.encryption !== 'AES-128') return [row(m.url, meta, off('受保護', `${m.encryption} 加密不支援`))];
  return [row(m.url, meta, queueButton(m.url, () => startHls(m, m.url, '', null)))];
}

const renderMediaRows = makeRenderer(mediaList, '尚未偵測到媒體');
const renderMedia = () => renderMediaRows(media.filter((m) => !m.parent).flatMap(rowsFor));

// ---- Download queue -------------------------------------------------------------------

// Native downloads report progress through chrome.downloads, not the job record.
const nativeProgress = new Map(); // downloadId -> { bytes, total }

function progressText(j) {
  if (j.kind === 'native') {
    const p = nativeProgress.get(j.downloadId);
    if (!p) return '下載中';
    return p.total > 0 ? `${Math.floor((p.bytes / p.total) * 100)}% · ${formatBytes(p.total)}` : formatBytes(p.bytes);
  }
  if (!j.total) return j.bytes ? formatBytes(j.bytes) : '準備中';
  const pct = `${Math.floor((j.done / j.total) * 100)}%`;
  return j.kind === 'hls' ? `${pct} · ${j.done}/${j.total} 片段` : `${pct} · ${formatBytes(j.total)}`;
}

function jobRow(j) {
  const remove = { text: '✕', title: '從清單移除', onClick: () => send({ type: 'remove-job', id: j.id }) };
  const spec = { key: j.id, name: j.filename, title: j.url, meta: [], buttons: [] };
  switch (j.status) {
    case 'running':
      spec.meta = [progressText(j)];
      spec.buttons = [{ text: '取消', onClick: () => send({ type: 'cancel-job', id: j.id }) }];
      break;
    case 'saving':
      spec.meta = ['存檔中'];
      break;
    case 'done':
      spec.meta = ['完成', formatBytes(j.bytes || nativeProgress.get(j.downloadId)?.total)];
      spec.buttons = [{ text: '顯示', onClick: () => chrome.downloads.show(j.downloadId) }, remove];
      break;
    case 'failed':
      spec.meta = [`失敗：${j.error || '未知錯誤'}`];
      spec.metaError = true;
      spec.buttons = [remove];
      break;
    default:
      spec.meta = ['已取消'];
      spec.buttons = [remove];
  }
  return spec;
}

const renderJobRows = makeRenderer(jobList, '沒有下載');
const renderJobs = () => renderJobRows(jobs.map(jobRow));

async function pollNative() {
  const active = jobs.filter((j) => j.kind === 'native' && j.downloadId != null);
  if (!active.length) return;
  const items = await chrome.downloads.search({});
  const byId = new Map(items.map((d) => [d.id, d]));
  for (const j of active) {
    const d = byId.get(j.downloadId);
    if (d) nativeProgress.set(j.downloadId, { bytes: d.bytesReceived, total: d.totalBytes });
  }
  renderJobs();
}

setInterval(pollNative, 700);

// ---- Startup --------------------------------------------------------------------------

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes[pageKey]) applyPage(changes[pageKey].newValue);
  if (changes[mediaKey]) {
    media = changes[mediaKey].newValue || [];
    renderMedia();
  }
  if (changes.jobs) {
    jobs = changes.jobs.newValue || [];
    renderJobs();
  }
});

await send({ type: 'viewer-open' });

const stored = await chrome.storage.session.get([mediaKey, pageKey, 'jobs']);
media = stored[mediaKey] || [];
jobs = stored.jobs || [];
applyPage(stored[pageKey]);
renderMedia();
renderJobs();

const initial = normalize(new URL(location.href).searchParams.get('url') || page.url || '');
if (initial) load(initial);
else addr.focus();
