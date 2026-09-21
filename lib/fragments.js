// Turns what a player appended to one SourceBuffer back into a playable file. Appends can
// repeat or arrive out of order (the player re-fetches after seeks), and may switch quality
// (a new init segment); fragments are keyed by their timestamp, sorted and de-duplicated,
// and only the init segment that most of the data belongs to is kept.

// ---- fragmented MP4 -------------------------------------------------------------------

const fourcc = (b, i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
const u32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

const MP4_TOP = new Set(['ftyp', 'moov', 'styp', 'sidx', 'moof', 'mdat', 'emsg', 'prft', 'free', 'skip']);

// Top-level boxes -> [{ type, start, end }]. After damage (an append cut short by a seek)
// it skips ahead to the next plausible box.
export function mp4Boxes(b) {
  const out = [];
  let i = 0;
  while (i + 8 <= b.length) {
    let size = u32(b, i);
    const type = fourcc(b, i + 4);
    let header = 8;
    if (size === 1 && i + 16 <= b.length) {
      size = u32(b, i + 8) * 2 ** 32 + u32(b, i + 12);
      header = 16;
    } else if (size === 0) size = b.length - i;
    // A box cut short by an aborted append still declares its full size and would swallow
    // what follows; a real box ends exactly where the next plausible one starts.
    if (!MP4_TOP.has(type) || size < header || i + size > b.length || !boxStartsAt(b, i + size)) {
      const next = resyncMp4(b, i + 1);
      if (next < 0) break;
      i = next;
      continue;
    }
    out.push({ type, start: i, end: i + size });
    i += size;
  }
  return out;
}

function boxStartsAt(b, j) {
  if (j === b.length) return true;
  return j + 8 <= b.length && u32(b, j) >= 8 && MP4_TOP.has(fourcc(b, j + 4));
}

// Next offset >= `from` where a moof/ftyp/styp box header starts (its type sits 4 bytes in).
function resyncMp4(b, from) {
  for (let i = from + 4; i + 4 <= b.length; i++) {
    const t = fourcc(b, i);
    if (t === 'moof' || t === 'ftyp' || t === 'styp') return i - 4;
  }
  return -1;
}

// Children of a container box -> [{ type, start, end }] (absolute offsets).
function children(b, start, end, skip = 8) {
  const out = [];
  let i = start + skip;
  while (i + 8 <= end) {
    const size = u32(b, i);
    if (size < 8 || i + size > end) break;
    out.push({ type: fourcc(b, i + 4), start: i, end: i + size });
    i += size;
  }
  return out;
}

const find = (b, box, type) => children(b, box.start, box.end).find((c) => c.type === type);

// Decode time of a moof: its first traf's tfdt.
function moofTime(b, moof) {
  const traf = find(b, moof, 'traf');
  const tfdt = traf && find(b, traf, 'tfdt');
  if (!tfdt) return null;
  const v = b[tfdt.start + 8];
  return v === 1 ? u32(b, tfdt.start + 12) * 2 ** 32 + u32(b, tfdt.start + 16) : u32(b, tfdt.start + 12);
}

function splitMp4(b) {
  const inits = [];
  const frags = [];
  const boxes = mp4Boxes(b);
  let initStart = null;
  for (let k = 0; k < boxes.length; k++) {
    const box = boxes[k];
    if (box.type === 'ftyp') initStart = box.start;
    else if (box.type === 'moov') {
      inits.push(b.subarray(initStart ?? box.start, box.end));
      initStart = null;
    } else if (box.type === 'moof') {
      const mdat = boxes[k + 1]?.type === 'mdat' ? boxes[k + 1] : null;
      if (!mdat) continue; // cut short
      frags.push({ init: inits.length - 1, time: moofTime(b, box), bytes: b.subarray(box.start, mdat.end) });
      k++;
    }
  }
  return { inits, frags };
}

// ---- WebM -----------------------------------------------------------------------------

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const CLUSTER = 0x1f43b675;
const TIMECODE = 0xe7;
const CLUSTER_CHILDREN = new Set([TIMECODE, 0xa3, 0xa0, 0xa7, 0xab, 0x5854]);

// EBML variable-length integers. IDs keep their marker bit; sizes drop it.
function vint(b, i, keepMarker) {
  const first = b[i];
  if (first === undefined || first === 0) return null;
  let len = 1;
  while (!(first & (0x80 >> (len - 1)))) len++;
  if (i + len > b.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  let allOnes = value === (0xff >> len);
  for (let k = 1; k < len; k++) {
    value = value * 256 + b[i + k];
    if (b[i + k] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

function element(b, i) {
  const id = vint(b, i, true);
  if (!id) return null;
  const size = vint(b, i + id.len, false);
  if (!size) return null;
  const dataStart = i + id.len + size.len;
  return { id: id.value, start: i, dataStart, end: size.unknown ? null : dataStart + size.value };
}

function clusterEnd(b, el) {
  if (el.end !== null) return Math.min(el.end, b.length);
  // Unknown size: runs until something that cannot be inside a cluster.
  let i = el.dataStart;
  while (i < b.length) {
    const child = element(b, i);
    if (!child || child.end === null || !CLUSTER_CHILDREN.has(child.id)) break;
    i = child.end;
  }
  return i;
}

function clusterTime(b, el, end) {
  let i = el.dataStart;
  while (i < end) {
    const child = element(b, i);
    if (!child || child.end === null) return null;
    if (child.id === TIMECODE) {
      let v = 0;
      for (let k = child.dataStart; k < child.end; k++) v = v * 256 + b[k];
      return v;
    }
    i = child.end;
  }
  return null;
}

function resyncWebm(b, from) {
  for (let i = from; i + 4 <= b.length; i++) {
    const id = u32(b, i);
    if (id === CLUSTER || id === EBML) return i;
  }
  return -1;
}

function splitWebm(b) {
  const inits = [];
  const frags = [];
  let i = 0;
  let initStart = null;
  while (i < b.length) {
    const el = element(b, i);
    if (!el) break;
    if (el.id === EBML) {
      initStart = i;
      i = el.end ?? b.length;
    } else if (el.id === SEGMENT) {
      i = el.dataStart; // descend: its children follow
    } else if (el.id === CLUSTER) {
      if (initStart !== null) {
        inits.push(b.subarray(initStart, i));
        initStart = null;
      }
      const end = clusterEnd(b, el);
      if (end > el.dataStart) frags.push({ init: inits.length - 1, time: clusterTime(b, el, end), bytes: b.subarray(i, end) });
      i = end;
    } else if (el.end !== null && el.end <= b.length && el.end > i) {
      i = el.end; // Info, Tracks, SeekHead, Cues...: part of the init while one is open
    } else {
      const next = resyncWebm(b, i + 1);
      if (next < 0) break;
      i = next;
    }
  }
  if (initStart !== null) inits.push(b.subarray(initStart, i));
  return { inits, frags };
}

// ---- assembly -------------------------------------------------------------------------

export const containerOf = (mime) => (/webm/i.test(mime) ? 'webm' : 'mp4');

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c instanceof Uint8Array ? c : new Uint8Array(c), o);
    o += c.byteLength;
  }
  return out;
}

// Each fragment's [start, end) in seconds; the end is the next start in the same quality,
// or that quality's typical fragment length for its last one.
function timeline(frags, scale) {
  const byInit = new Map();
  for (const f of frags) {
    if (f.init < 0 || f.time === null || !scale[f.init]) continue;
    f.start = f.time * scale[f.init];
    if (!byInit.has(f.init)) byInit.set(f.init, []);
    byInit.get(f.init).push(f);
  }
  for (const list of byInit.values()) {
    const starts = [...new Set(list.map((f) => f.start))].sort((a, b) => a - b);
    const steps = starts.slice(1).map((t, i) => t - starts[i]).sort((a, b) => a - b);
    const typical = steps.length ? steps[Math.floor(steps.length / 2)] : 0;
    for (const f of list) {
      const next = starts.find((t) => t > f.start + 1e-6);
      f.end = next ?? f.start + typical;
    }
  }
  return byInit;
}

// chunks: what was appended, in order.
// -> { init, fragments: Uint8Array[], starts: seconds[] | null, qualities, dropped }
//
// Players switch quality as they go, so the appends hold several qualities (init segments).
// For every stretch of time the best quality that has it is used (best = most bytes per
// fragment); lower qualities only fill what better ones lack. MP4 keeps one sample
// description per quality used (fragments point at theirs); WebM needs none, as VP9/AV1
// change resolution at keyframes.
export function assembleTrack(chunks, mime) {
  const b = concat(chunks);
  const webm = containerOf(mime) === 'webm';
  const { inits, frags } = webm ? splitWebm(b) : splitMp4(b);
  if (!inits.length) throw new Error('沒有找到初始化片段，請重新整理頁面後再試');

  const scale = inits.map((i) => (webm ? webmSecondsPerTick(i) : mp4SecondsPerTick(i)));
  const byInit = timeline(frags, scale);
  const quality = (k) => {
    const list = frags.filter((f) => f.init === k);
    return list.reduce((n, f) => n + f.bytes.length, 0) / (list.length || 1);
  };
  const ranked = [...byInit.keys()].sort((x, y) => quality(y) - quality(x));
  const best = ranked[0] ?? inits.length - 1;
  // Qualities an MP4 can carry as extra sample descriptions of one track.
  const mixable = webm ? ranked : ranked.filter((k) => k === best || mp4Compatible(inits[best], inits[k]));

  const kept = [];
  const covered = [];
  const overlaps = (s, e) => covered.some(([a, z]) => s < z - 0.05 && e > a + 0.05);
  for (const k of mixable) {
    for (const f of byInit.get(k) || []) {
      if (overlaps(f.start, f.end)) continue;
      kept.push(f);
      covered.push([f.start, f.end]);
    }
  }

  // No timestamps to go by: one quality, in append order, without exact repeats.
  if (!kept.length) {
    const seen = new Set();
    for (const f of frags) {
      if (f.init !== inits.length - 1) continue;
      const key = `${f.bytes.length}:${f.bytes[f.bytes.length - 1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      kept.push(f);
    }
    const init = webm ? unsizeSegment(inits[inits.length - 1]) : inits[inits.length - 1];
    return { init, fragments: kept.map((f) => f.bytes), starts: null, qualities: 1, dropped: frags.length - kept.length };
  }

  kept.sort((x, y) => x.start - y.start);
  const used = [...new Set(kept.map((f) => f.init))].sort((x, y) => ranked.indexOf(x) - ranked.indexOf(y));
  const duration = Math.max(...kept.map((f) => f.end));
  let init;
  let fragments;
  if (webm) {
    init = withWebmDuration(unsizeSegment(inits[best]), duration / scale[best]);
    fragments = kept.map((f) => f.bytes);
  } else {
    init = withMp4Duration(used.length > 1 ? multiQualityInit(inits, used) : inits[used[0]], duration);
    fragments = kept.map((f) => (used.length > 1 ? pointAtDescription(f.bytes, used.indexOf(f.init) + 1, trackId(inits[used[0]])) : f.bytes));
  }
  return { init, fragments, starts: kept.map((f) => f.start), qualities: used.length, dropped: frags.length - kept.length };
}

// Parts of [0, duration] the fragments do not reach: before the first one, and wherever
// two starts are much further apart than fragments usually are. -> [[from, to], ...]
export function gaps(starts, duration) {
  if (!starts?.length || !Number.isFinite(duration)) return [];
  const steps = starts.slice(1).map((t, i) => t - starts[i]).filter((d) => d > 0).sort((a, b) => a - b);
  const typical = steps.length ? steps[Math.floor(steps.length / 2)] : duration;
  const out = [];
  if (starts[0] > Math.max(1, typical * 0.5)) out.push([0, starts[0]]);
  for (let i = 1; i < starts.length; i++) {
    if (starts[i] - starts[i - 1] > typical * 2.5) out.push([starts[i - 1] + typical, starts[i]]);
  }
  const last = starts[starts.length - 1] + typical;
  if (duration - last > typical * 1.5) out.push([last, duration]);
  return out;
}

// ---- MP4 init surgery -----------------------------------------------------------------

const w32 = (b, i, v) => {
  b[i] = (v >>> 24) & 255;
  b[i + 1] = (v >>> 16) & 255;
  b[i + 2] = (v >>> 8) & 255;
  b[i + 3] = v & 255;
};
const w64 = (b, i, v) => {
  w32(b, i, Math.floor(v / 2 ** 32));
  w32(b, i + 4, v % 2 ** 32);
};

// The box at `path` (e.g. ['moov', 'trak', 'mdia', 'mdhd']) with its ancestors, or null.
function boxPath(b, path) {
  let box = mp4Boxes(b).find((x) => x.type === path[0]);
  const chain = box ? [box] : [];
  for (const type of path.slice(1)) {
    if (!box) return null;
    box = find(b, box, type);
    if (box) chain.push(box);
  }
  return box ? chain : null;
}

function mdhdOf(init) {
  return boxPath(init, ['moov', 'trak', 'mdia', 'mdhd'])?.at(-1) || null;
}

function mp4SecondsPerTick(init) {
  const mdhd = mdhdOf(init);
  if (!mdhd) return null;
  const timescale = u32(init, mdhd.start + (init[mdhd.start + 8] === 1 ? 28 : 20));
  return timescale ? 1 / timescale : null;
}

function trackId(init) {
  const tkhd = boxPath(init, ['moov', 'trak', 'tkhd'])?.at(-1);
  return tkhd ? u32(init, tkhd.start + (init[tkhd.start + 8] === 1 ? 28 : 20)) : 1;
}

// Two qualities can share one track when their media timescales agree (fragment times stay
// valid) and each describes a single track.
function mp4Compatible(a, b) {
  const ta = mp4SecondsPerTick(a);
  const tb = mp4SecondsPerTick(b);
  const traks = (x) => {
    const moov = mp4Boxes(x).find((y) => y.type === 'moov');
    return moov ? children(x, moov.start, moov.end).filter((c) => c.type === 'trak').length : 0;
  };
  return !!ta && ta === tb && traks(a) === 1 && traks(b) === 1;
}

// Replaces the box `chain.at(-1)` with `bytes`, fixing the sizes of its ancestors.
function replaceBox(b, chain, bytes) {
  const target = chain.at(-1);
  const delta = bytes.length - (target.end - target.start);
  const out = concat([b.subarray(0, target.start), bytes, b.subarray(target.end)]);
  for (const box of chain.slice(0, -1)) w32(out, box.start, u32(out, box.start) + delta);
  return out;
}

// The best quality's init, its sample description table holding one entry per quality used.
function multiQualityInit(inits, used) {
  const entries = used.map((k) => {
    const stsd = boxPath(inits[k], ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']).at(-1);
    return children(inits[k], stsd.start, stsd.end, 16).map((e) => inits[k].subarray(e.start, e.end));
  });
  const base = inits[used[0]];
  const chain = boxPath(base, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);
  const stsd = chain.at(-1);
  const body = concat(entries.map((list) => list[0]));
  const head = new Uint8Array(16);
  w32(head, 0, 16 + body.length);
  head.set(base.subarray(stsd.start + 4, stsd.start + 12), 4); // 'stsd' + version/flags
  w32(head, 12, entries.length);
  return replaceBox(base, chain, concat([head, body]));
}

// Makes a fragment use sample description `index` (1-based) of track `id`: sets the tfhd's
// sample_description_index, inserting the field if absent (which moves the media data 4
// bytes further from the moof, so trun's data offset follows).
function pointAtDescription(frag, index, id) {
  const boxes = mp4Boxes(frag);
  const moof = boxes.find((x) => x.type === 'moof');
  const traf = moof && find(frag, moof, 'traf');
  const tfhd = traf && find(frag, traf, 'tfhd');
  if (!tfhd) return frag;
  const out = frag.slice();
  w32(out, tfhd.start + 12, id);
  const flags = (out[tfhd.start + 9] << 16) | (out[tfhd.start + 10] << 8) | out[tfhd.start + 11];
  const at = tfhd.start + 16 + (flags & 0x01 ? 8 : 0);
  if (flags & 0x02) {
    w32(out, at, index);
    return out;
  }
  const field = new Uint8Array(4);
  w32(field, 0, index);
  const grown = concat([out.subarray(0, at), field, out.subarray(at)]);
  grown[tfhd.start + 11] |= 0x02;
  for (const box of [moof, traf, tfhd]) w32(grown, box.start, u32(grown, box.start) + 4);
  const trun = find(grown, { start: traf.start, end: traf.end + 4 }, 'trun');
  if (trun && grown[trun.start + 11] & 0x01) w32(grown, trun.start + 16, u32(grown, trun.start + 16) + 4);
  return grown;
}

// Writes the total length into mvhd, tkhd and mdhd, which MSE streams leave at zero, so
// players can show it and seek.
function withMp4Duration(init, seconds) {
  const out = init.slice();
  const mvhd = boxPath(out, ['moov', 'mvhd'])?.at(-1);
  const tkhd = boxPath(out, ['moov', 'trak', 'tkhd'])?.at(-1);
  const mdhd = mdhdOf(out);
  const v1 = (box) => out[box.start + 8] === 1;
  const set = (box, v0At, v1At, value) => (v1(box) ? w64(out, box.start + v1At, value) : w32(out, box.start + v0At, Math.min(value, 0xffffffff)));
  if (mvhd) {
    const movieScale = u32(out, mvhd.start + (v1(mvhd) ? 28 : 20));
    const ticks = Math.round(seconds * movieScale);
    set(mvhd, 24, 32, ticks);
    if (tkhd) set(tkhd, 28, 36, ticks);
  }
  if (mdhd) {
    const mediaScale = u32(out, mdhd.start + (v1(mdhd) ? 28 : 20));
    set(mdhd, 24, 32, Math.round(seconds * mediaScale));
  }
  return out;
}

// ---- WebM init surgery ----------------------------------------------------------------

const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const SEEK_HEAD = 0x114d9b74;
const CUES = 0x1c53bb6b;

// TimecodeScale (nanoseconds per cluster tick, default 1 ms) from the Segment's Info.
function webmSecondsPerTick(init) {
  const info = segmentChildren(init).find((c) => c.id === INFO);
  if (!info) return 1e-3;
  for (let k = info.dataStart; k < info.end; ) {
    const child = element(init, k);
    if (!child || child.end === null) break;
    if (child.id === TIMECODE_SCALE) {
      let v = 0;
      for (let j = child.dataStart; j < child.end; j++) v = v * 256 + init[j];
      return v / 1e9;
    }
    k = child.end;
  }
  return 1e-3;
}

// Level-1 elements inside the Segment of an init: [{ id, start, dataStart, end }].
function segmentChildren(init) {
  let i = 0;
  while (i < init.length) {
    const el = element(init, i);
    if (!el) return [];
    if (el.id !== SEGMENT) {
      i = el.end ?? init.length;
      continue;
    }
    const out = [];
    for (let k = el.dataStart; k < init.length; ) {
      const child = element(init, k);
      if (!child || child.end === null) break;
      out.push(child);
      k = child.end;
    }
    return out;
  }
  return [];
}

// The reassembled clusters no longer add up to a declared Segment size; mark it unknown
// ("runs to the end of the file"), as MSE streams usually do anyway.
function unsizeSegment(init) {
  let i = 0;
  while (i < init.length) {
    const el = element(init, i);
    if (!el) break;
    if (el.id !== SEGMENT) {
      i = el.end ?? init.length;
      continue;
    }
    const unknown = Uint8Array.of(0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
    return concat([init.subarray(0, i + 4), unknown, init.subarray(el.dataStart)]);
  }
  return init;
}

const sizeVint = (n) => {
  const b = new Uint8Array(8);
  w64(b, 0, n);
  b[0] |= 0x01;
  return b;
};

// Adds a Duration (in ticks) to Info. SeekHead and Cues are dropped: their byte positions
// no longer match the reassembled file.
function withWebmDuration(init, ticks) {
  const kids = segmentChildren(init);
  if (!kids.length) return init;
  const segmentData = kids[0].start;
  const parts = [init.subarray(0, segmentData)];
  for (const c of kids) {
    if (c.id === SEEK_HEAD || c.id === CUES) continue;
    if (c.id !== INFO) {
      parts.push(init.subarray(c.start, c.end));
      continue;
    }
    const keep = [];
    for (let k = c.dataStart; k < c.end; ) {
      const child = element(init, k);
      if (!child || child.end === null) break;
      if (child.id !== DURATION) keep.push(init.subarray(child.start, child.end));
      k = child.end;
    }
    const value = new Uint8Array(8);
    new DataView(value.buffer).setFloat64(0, ticks);
    const duration = concat([Uint8Array.of(0x44, 0x89, 0x88), value]);
    const body = concat([...keep, duration]);
    parts.push(concat([Uint8Array.of(0x15, 0x49, 0xa9, 0x66), sizeVint(body.length), body]));
  }
  return concat(parts);
}
