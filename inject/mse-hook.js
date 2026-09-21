// Runs in the page's own JS world at document_start while the viewer window is open.
// Keeps a copy of every buffer a player feeds into Media Source Extensions, so videos that
// play from blob: URLs (no downloadable file on the network) can still be saved, and can
// drive the player to buffer the whole video quickly ("walking" the buffer).
// Talks to the isolated content script through window.postMessage.
(() => {
  if (window.__vdMseHook || typeof MediaSource === 'undefined') return;
  window.__vdMseHook = true;

  const TAG = '__vd_mse__';
  const MAX_BYTES = 2 * 1024 ** 3; // per page; beyond this, capture stops
  const rand = () => Math.random().toString(36).slice(2);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const post = (msg) => window.postMessage({ [TAG]: msg.type, ...msg }, '*');

  const streams = new Map(); // SourceBuffer -> { id, source, mime, chunks, bytes, truncated }
  const sources = new Map(); // MediaSource -> { id, url }
  let total = 0;
  let timer = 0;

  const sourceOf = (ms) => {
    let s = sources.get(ms);
    if (!s) sources.set(ms, (s = { id: rand(), url: null }));
    return s;
  };

  const snapshot = () =>
    [...streams.values()].map(({ id, source, mime, bytes, truncated }) => ({ id, source, mime, bytes, truncated }));

  function announce(now = false) {
    if (timer && !now) return;
    clearTimeout(timer);
    timer = setTimeout(
      () => {
        timer = 0;
        post({ type: 'streams', streams: snapshot() });
      },
      now ? 0 : 500,
    );
  }

  // Which element plays a MediaSource: remember the blob: URL made for it.
  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = createObjectURL.apply(this, arguments);
    if (obj instanceof MediaSource) sourceOf(obj).url = url;
    return url;
  };

  const mediaSourceById = (id) => [...sources.entries()].find(([, s]) => s.id === id)?.[0] || null;

  function elementOf(ms) {
    const { url } = sourceOf(ms);
    return (
      [...document.querySelectorAll('video, audio')].find(
        (el) => el.srcObject === ms || (url && (el.src === url || el.currentSrc === url)),
      ) || null
    );
  }

  const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = addSourceBuffer.apply(this, arguments);
    streams.set(sb, {
      id: rand(),
      source: sourceOf(this).id,
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

  // ---- walking the buffer -------------------------------------------------------------
  // Players fetch ahead of the playhead, usually even while paused. Keeping the video muted
  // and paused, and moving the playhead to the edge of what is buffered, makes the player
  // fetch the whole video at network speed instead of playback speed. Players that only
  // fetch while playing are played at 16x instead.

  const walkers = new Map(); // job -> { paused, cancelled }

  function bufferedEnd(el) {
    const b = el.buffered;
    const t = el.currentTime;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.5 && b.end(i) >= t) return b.end(i);
    return t;
  }

  // Buffers [from, to] (to: the end); `to` lets a later pass fetch a stretch that is
  // still missing.
  async function walk(job, ms, from = 0, to = null) {
    const el = elementOf(ms);
    if (!el) throw new Error('找不到播放這個串流的影片元素');
    const duration = () => (Number.isFinite(ms.duration) ? ms.duration : el.duration);
    if (!Number.isFinite(duration())) throw new Error('直播串流無法下載');
    const state = walkers.get(job);
    const before = { muted: el.muted, rate: el.playbackRate };
    el.muted = true;
    el.pause();
    el.currentTime = from;
    let reached = from;
    let lastGain = Date.now();
    let playing = false;
    try {
      for (;;) {
        if (state.cancelled) throw new Error('已取消');
        if (state.paused) {
          el.pause();
          playing = false;
          await sleep(200);
          lastGain = Date.now();
          continue;
        }
        const d = duration();
        const end = bufferedEnd(el);
        if (end > reached + 0.01) {
          reached = end;
          lastGain = Date.now();
        }
        post({ type: 'walk-progress', job, at: reached, duration: d });
        if (reached >= Math.min(to ?? d, d) - 0.3) break;
        if (!playing && end - el.currentTime > 1) el.currentTime = end - 0.5;
        const stalled = Date.now() - lastGain;
        if (stalled > 3000 && !playing) {
          playing = true;
          el.playbackRate = 16;
          el.play().catch(() => {});
        } else if (stalled > 3000 && playing && end >= el.currentTime - 0.1) {
          el.currentTime = end + 0.1; // step over a gap in what is buffered
        }
        if (stalled > 30000) throw new Error('播放器停止緩衝');
        await sleep(150);
      }
    } finally {
      el.pause();
      el.playbackRate = before.rate;
      el.muted = before.muted;
    }
  }

  // A MediaSource to capture: the given one, else the one with the most data, else (no
  // player started yet) start the first video muted and wait for one to appear.
  async function pickSource(id) {
    const byId = id && mediaSourceById(id);
    if (byId) return byId;
    const busiest = () => {
      const bytes = new Map();
      for (const s of streams.values()) bytes.set(s.source, (bytes.get(s.source) || 0) + s.bytes);
      const top = [...bytes.entries()].sort((a, b) => b[1] - a[1])[0];
      return top ? mediaSourceById(top[0]) : null;
    };
    if (busiest()) return busiest();
    const video = document.querySelector('video');
    if (video) {
      video.muted = true;
      video.play().catch(() => {});
    }
    for (let i = 0; i < 50 && !busiest(); i++) await sleep(100);
    return busiest();
  }

  // ranges: stretches still missing, or none for the whole video.
  async function capture(job, sourceId, ranges) {
    walkers.set(job, { paused: false, cancelled: false });
    try {
      const ms = await pickSource(sourceId);
      if (!ms) throw new Error('這個頁面沒有以 MediaSource 播放的影片');
      if (!ranges?.length) await walk(job, ms);
      for (const [from, to] of ranges || []) await walk(job, ms, from, to);
      const id = sourceOf(ms).id;
      const tracks = [...streams.values()]
        .filter((s) => s.source === id && s.chunks.length)
        .map(({ mime, chunks, truncated }) => ({ mime, chunks, truncated }));
      const duration = Number.isFinite(ms.duration) ? ms.duration : elementOf(ms)?.duration;
      post({ type: 'walk-done', job, source: id, duration, tracks });
    } catch (e) {
      post({ type: 'walk-failed', job, error: e.message, cancelled: walkers.get(job)?.cancelled });
    } finally {
      walkers.delete(job);
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || typeof e.data !== 'object') return;
    const cmd = e.data[TAG];
    const w = walkers.get(e.data.job);
    if (cmd === 'hello') announce(true);
    else if (cmd === 'capture') capture(e.data.job, e.data.source, e.data.ranges);
    else if (cmd === 'capture-pause' && w) w.paused = true;
    else if (cmd === 'capture-resume' && w) w.paused = false;
    else if (cmd === 'capture-cancel' && w) w.cancelled = true;
  });
})();
