import { audioFor, variantLabel } from '../lib/hls.js';
import { displayName, filenameFor, formatBytes } from '../lib/media.js';

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const mediaKey = `tab:${tab.id}`;

const $ = (id) => document.getElementById(id);

// Quality picked per stream, kept across re-renders triggered by new detections.
const chosenVariant = new Map();

// Tiny element builder; text always goes through textContent, never innerHTML.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) el[k] = v;
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

function formatDuration(sec) {
  if (!sec) return '';
  const s = Math.round(sec);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

function copyButton(url) {
  const btn = h('button', {
    className: 'icon',
    title: '複製連結',
    textContent: '⧉',
    onclick: async () => {
      await navigator.clipboard.writeText(url);
      btn.textContent = '✓';
      setTimeout(() => (btn.textContent = '⧉'), 1200);
    },
  });
  return btn;
}

function row({ name, title, meta, actions }) {
  return h(
    'li',
    { className: 'item' },
    h(
      'div',
      { className: 'info' },
      h('div', { className: 'name', title, textContent: name }),
      h('div', { className: 'meta' }, meta),
    ),
    h('div', { className: 'actions' }, actions),
  );
}

const tag = (text) => h('span', { className: 'tag', textContent: text });
const span = (text, className) => text && h('span', { className, textContent: text });

function fileItem(m) {
  const btn = h('button', {
    className: 'primary',
    textContent: '下載',
    onclick: async () => {
      btn.disabled = true;
      const res = await send({ type: 'download', url: m.url, filename: filenameFor(tab.title, m.ext) });
      btn.textContent = res?.error ? '失敗' : '已開始';
      btn.title = res?.error || '';
    },
  });
  return row({
    name: displayName(m.url),
    title: m.url,
    meta: [tag(m.ext.toUpperCase()), span(formatBytes(m.size)), span(new URL(m.url).hostname)],
    actions: [copyButton(m.url), btn],
  });
}

function streamItem(m) {
  const meta = [tag('HLS')];
  const btn = h('button', { className: 'primary', textContent: '下載' });
  let select = null;

  if (!m.probed) {
    meta.push(span('解析中…'));
    btn.disabled = true;
  } else if (m.error) {
    meta.push(span(`無法解析：${m.error}`, 'error'));
    btn.disabled = true;
  } else if (m.variants) {
    select = h(
      'select',
      { title: '畫質', onchange: (e) => chosenVariant.set(m.id, e.target.value) },
      m.variants.map((v, i) =>
        h('option', {
          value: String(i),
          textContent: v.bandwidth
            ? `${variantLabel(v)} · ${(v.bandwidth / 1e6).toFixed(1)} Mbps`
            : variantLabel(v),
        }),
      ),
    );
    select.value = chosenVariant.get(m.id) ?? '0';
    meta.push(span(`${m.variants.length} 種畫質`));
    if (m.variants.some((v) => audioFor(v, m.audio))) meta.push(span('影像與音訊分開存檔'));
  } else if (m.live) {
    meta.push(span('直播（不支援）'));
    btn.disabled = true;
  } else {
    meta.push(span(formatDuration(m.duration)), span(`${m.segments} 個片段`));
    if (m.encryption) meta.push(span(m.encryption === 'AES-128' ? 'AES-128 加密' : `${m.encryption}（不支援）`));
    if (m.encryption && m.encryption !== 'AES-128') btn.disabled = true;
  }
  meta.push(span(new URL(m.url).hostname));

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const base = { type: 'download-hls', title: tab.title, referer: tab.url };
    if (m.variants) {
      const v = m.variants[Number(select.value)];
      const audio = audioFor(v, m.audio);
      await send({ ...base, url: v.url, tag: variantLabel(v) });
      if (audio) await send({ ...base, url: audio.url, tag: `音訊${audio.language ? ` ${audio.language}` : ''}` });
    } else {
      await send({ ...base, url: m.url, tag: '' });
    }
    btn.textContent = '已加入';
  });

  return row({
    name: displayName(m.url),
    title: m.url,
    meta,
    actions: [select, copyButton(m.url), btn],
  });
}

function renderMedia(list = []) {
  const visible = list.filter((m) => !m.parent);
  $('media-list').replaceChildren(...visible.map((m) => (m.kind === 'hls' ? streamItem(m) : fileItem(m))));
  $('empty').hidden = visible.length > 0;
}

const JOB_STATUS = {
  running: (j) => (j.total ? `${j.done}/${j.total} 片段 · ${formatBytes(j.bytes)}` : '準備中…'),
  saving: () => '存檔中…',
  done: (j) => `已完成 · ${formatBytes(j.bytes)}`,
  failed: (j) => `失敗：${j.error || '未知錯誤'}`,
  cancelled: () => '已取消',
};

function jobItem(j) {
  const pct = j.status === 'running' ? (j.total ? (j.done / j.total) * 100 : 0) : 100;
  const actions = [];
  if (j.status === 'running') {
    actions.push(h('button', { textContent: '取消', onclick: () => send({ type: 'cancel-job', id: j.id }) }));
  } else {
    if (j.status === 'done') {
      actions.push(
        h('button', { textContent: '顯示', onclick: () => chrome.downloads.show(j.downloadId) }),
      );
    }
    actions.push(
      h('button', {
        className: 'icon',
        title: '從清單移除',
        textContent: '✕',
        onclick: () => send({ type: 'remove-job', id: j.id }),
      }),
    );
  }
  const li = row({
    name: j.filename,
    title: j.url,
    meta: span(JOB_STATUS[j.status](j), j.status === 'failed' ? 'error' : ''),
    actions,
  });
  li.classList.add(j.status === 'done' ? 'done' : j.status === 'failed' ? 'failed' : 'active');
  li.querySelector('.info').append(
    h('div', { className: 'progress' }, h('div', { style: `width:${pct}%` })),
  );
  return li;
}

function renderJobs(jobs = []) {
  $('jobs').hidden = !jobs.length;
  $('job-list').replaceChildren(...jobs.map(jobItem));
}

const { [mediaKey]: media, jobs } = await chrome.storage.session.get([mediaKey, 'jobs']);
renderMedia(media);
renderJobs(jobs);

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes[mediaKey]) renderMedia(changes[mediaKey].newValue);
  if (changes.jobs) renderJobs(changes.jobs.newValue);
});
