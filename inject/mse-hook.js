// Runs in the page's own JS world at document_start while the viewer window is open.
// Keeps a copy of every buffer a player feeds into Media Source Extensions, so videos that
// play from blob: URLs (no downloadable file on the network) can still be saved.
// Talks to the isolated content script through window.postMessage.
(() => {
  if (window.__vdMseHook || typeof MediaSource === 'undefined') return;
  window.__vdMseHook = true;

  const TAG = '__vd_mse__';
  const MAX_BYTES = 2 * 1024 ** 3; // per page; beyond this, capture stops

  const streams = new Map(); // SourceBuffer -> { id, mime, chunks, bytes, truncated }
  let total = 0;
  let timer = 0;

  const snapshot = () =>
    [...streams.values()].map(({ id, mime, bytes, truncated }) => ({ id, mime, bytes, truncated }));

  function announce(now = false) {
    if (timer && !now) return;
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        timer = 0;
        window.postMessage({ [TAG]: 'streams', streams: snapshot() }, '*');
      },
      now ? 0 : 500,
    );
  }

  const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = addSourceBuffer.apply(this, arguments);
    streams.set(sb, {
      id: Math.random().toString(36).slice(2),
      mime: String(mime),
      chunks: [],
      bytes: 0,
      truncated: false,
    });
    announce();
    return sb;
  };

  const appendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    const s = streams.get(this);
    if (s && !s.truncated) {
      const view = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      if (total + view.byteLength > MAX_BYTES) {
        s.truncated = true;
      } else {
        // Copy: players often reuse or transfer the buffer after appending it.
        s.chunks.push(view.slice());
        s.bytes += view.byteLength;
        total += view.byteLength;
      }
      announce();
    }
    return appendBuffer.apply(this, arguments);
  };

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data !== 'object') return;
    const cmd = e.data[TAG];
    if (cmd === 'hello') announce(true);
    if (cmd === 'save') {
      const s = [...streams.values()].find((x) => x.id === e.data.id);
      if (!s) return;
      const blob = new Blob(s.chunks, { type: s.mime.split(';')[0] });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = e.data.filename;
      a.style.display = 'none';
      document.documentElement.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    }
  });
})();
