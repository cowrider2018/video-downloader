import { displayName, filenameFor, formatBytes } from '../lib/media.js';

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const mediaKey = `tab:${tab.id}`;

const $ = (id) => document.getElementById(id);

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
  return h(
    'li',
    { className: 'item' },
    h(
      'div',
      { className: 'info' },
      h('div', { className: 'name', title: m.url, textContent: displayName(m.url) }),
      h(
        'div',
        { className: 'meta' },
        h('span', { className: 'tag', textContent: m.ext.toUpperCase() }),
        m.size != null && h('span', { textContent: formatBytes(m.size) }),
        h('span', { textContent: new URL(m.url).hostname }),
      ),
    ),
    h('div', { className: 'actions' }, copyButton(m.url), btn),
  );
}

function streamItem(m) {
  const li = fileItem(m);
  const btn = li.querySelector('button.primary');
  btn.disabled = true;
  btn.title = '串流下載尚未支援';
  return li;
}

function renderMedia(list = []) {
  const visible = list.filter((m) => !m.parent);
  $('media-list').replaceChildren(...visible.map((m) => (m.kind === 'hls' ? streamItem(m) : fileItem(m))));
  $('empty').hidden = visible.length > 0;
}

const { [mediaKey]: media } = await chrome.storage.session.get(mediaKey);
renderMedia(media);

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes[mediaKey]) renderMedia(changes[mediaKey].newValue);
});
