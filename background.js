import { classify, sizeFromHeaders, urlExt } from './lib/media.js';

// Detected media lives in storage.session under `tab:<id>`, because the service worker
// can be torn down at any moment and in-memory state would be lost with it.
const tabKey = (tabId) => `tab:${tabId}`;

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

async function addMedia(tabId, item) {
  const list = await update(tabKey(tabId), (list = []) => {
    const old = list.find((m) => m.url === item.url);
    if (!old) return [...list, { id: crypto.randomUUID(), detectedAt: Date.now(), ...item }];
    if (old.size == null && item.size != null) {
      return list.map((m) => (m === old ? { ...m, size: item.size } : m));
    }
  });
  setBadge(tabId, list);
}

async function clearTab(tabId) {
  await update(tabKey(tabId), () => []);
  setBadge(tabId);
}

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
  }
});
