import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assembleTrack, gaps, mp4Boxes } from '../lib/fragments.js';

// ---- MP4 builders ----
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const box = (type, ...payload) => {
  const body = payload.flatMap((p) => [...p]);
  return Uint8Array.from([...u32(8 + body.length), ...ascii(type), ...body]);
};
const cat = (...parts) => {
  const flat = parts.flat(Infinity);
  const out = new Uint8Array(flat.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of flat) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const read32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

// Init of one video track (id 1, media timescale 1000); `tag` marks its sample entry.
const init = (tag, timescale = 1000) => [
  box('ftyp', ascii('isom')),
  box(
    'moov',
    box('mvhd', [0, 0, 0, 0], u32(0), u32(0), u32(1000), u32(0)),
    box(
      'trak',
      box('tkhd', [0, 0, 0, 3], u32(0), u32(0), u32(1), u32(0), u32(0)),
      box(
        'mdia',
        box('mdhd', [0, 0, 0, 0], u32(0), u32(0), u32(timescale), u32(0)),
        box('minf', box('stbl', box('stsd', [0, 0, 0, 0], u32(1), box('avc1', [tag])))),
      ),
    ),
  ),
];
// tfhd with default-base-is-moof, trun with a data offset.
const frag = (t, fill, size = 2) => {
  const traf = box(
    'traf',
    box('tfhd', [0, 2, 0, 0], u32(1)),
    box('tfdt', [1, 0, 0, 0], u32(Math.floor(t / 2 ** 32)), u32(t % 2 ** 32)),
    box('trun', [0, 0, 0, 1], u32(1), u32(0)),
  );
  const moof = box('moof', box('mfhd', [0, 0, 0, 0], u32(1)), traf);
  return [moof, box('mdat', new Array(size).fill(fill))];
};
const mdatFills = (bytes) =>
  mp4Boxes(bytes)
    .filter((b) => b.type === 'mdat')
    .map((b) => bytes[b.start + 8]);
// Finds a nested box by type path; stsd's entries start 16 bytes in.
const path = (b, types) => {
  let range = [0, b.length];
  let hit = null;
  for (const type of types) {
    hit = null;
    for (let i = range[0]; i + 8 <= range[1]; ) {
      const size = read32(b, i);
      if (String.fromCharCode(...b.subarray(i + 4, i + 8)) === type) {
        hit = { start: i, end: i + size };
        break;
      }
      if (size < 8) break;
      i += size;
    }
    if (!hit) return null;
    const skip = type === 'stsd' ? 16 : ['tfhd', 'trun', 'mvhd', 'mdhd', 'tkhd'].includes(type) ? 12 : 8;
    range = [hit.start + skip, hit.end];
  }
  return hit;
};

test('mp4: fragments are sorted by decode time and de-duplicated', () => {
  const chunks = [cat(init(1)), cat(frag(0, 10)), cat(frag(2000, 12)), cat(frag(1000, 11)), cat(frag(1000, 11)), cat(frag(3000, 13))];
  const { init: head, fragments, dropped, starts, qualities } = assembleTrack(chunks, 'video/mp4; codecs="avc1"');
  assert.deepEqual(mp4Boxes(head).map((b) => b.type), ['ftyp', 'moov']);
  assert.deepEqual(mdatFills(cat(fragments)), [10, 11, 12, 13]);
  assert.deepEqual(starts, [0, 1, 2, 3]);
  assert.equal(dropped, 1);
  assert.equal(qualities, 1);
  const mvhd = path(head, ['moov', 'mvhd']);
  assert.equal(read32(head, mvhd.start + 24), 4000, 'duration written (4 s at timescale 1000)');
});

test('mp4: qualities are mixed, the better one wins where both exist', () => {
  // low quality (small fragments) covers 0-3, high quality (big fragments) covers 1-3
  const chunks = [cat(init(1)), cat(frag(0, 10)), cat(frag(1000, 11)), cat(frag(2000, 12)), cat(init(2)), cat(frag(1000, 21, 8)), cat(frag(2000, 22, 8))];
  const { init: head, fragments, qualities } = assembleTrack(chunks, 'video/mp4');
  assert.equal(qualities, 2);
  assert.deepEqual(mdatFills(cat(fragments)), [10, 21, 22]);
  const stsd = path(head, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd']);
  assert.equal(read32(head, stsd.start + 12), 2, 'one sample description per quality');
  assert.deepEqual([head[stsd.start + 24], head[stsd.start + 33]], [2, 1], 'best quality first');
  // each fragment points at its description, and its data offset follows the moved mdat
  for (const [f, index] of [[fragments[0], 2], [fragments[1], 1]]) {
    const tfhd = path(f, ['moof', 'traf', 'tfhd']);
    assert.equal(f[tfhd.start + 11] & 0x02, 0x02);
    assert.equal(read32(f, tfhd.start + 16), index);
    const trun = path(f, ['moof', 'traf', 'trun']);
    assert.equal(read32(f, trun.start + 16), 4);
    const [moof, mdat] = mp4Boxes(f);
    assert.equal(mdat.start, moof.end, 'mdat right after the grown moof');
  }
});

test('mp4: a cut-short append does not swallow what follows', () => {
  const cut = cat(frag(4000, 99)).subarray(0, 30); // aborted mid-fragment
  const { fragments } = assembleTrack([cat(init(1)), cat(frag(0, 10)), cut, cat(frag(1000, 11))], 'video/mp4');
  assert.deepEqual(mdatFills(cat(fragments)), [10, 11]);
});

test('mp4: a single append holding init and several fragments', () => {
  const { fragments } = assembleTrack([cat(init(1), frag(1000, 2), frag(0, 1))], 'audio/mp4');
  assert.deepEqual(mdatFills(cat(fragments)), [1, 2]);
});

test('mp4: without a timescale, append order without exact repeats', () => {
  const bare = [box('ftyp', ascii('isom')), box('moov', box('mvhd', [0]))];
  const { fragments, starts } = assembleTrack([cat(bare), cat(frag(1000, 2)), cat(frag(1000, 2)), cat(frag(0, 1))], 'video/mp4');
  assert.deepEqual(mdatFills(cat(fragments)), [2, 1]);
  assert.equal(starts, null);
});

// ---- WebM builders ----
const el = (id, ...payload) => {
  const body = payload.flatMap((p) => [...p]);
  return Uint8Array.from([...id, 0x01, 0, 0, 0, ...u32(body.length), ...body]);
};
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const SEEK_HEAD = [0x11, 0x4d, 0x9b, 0x74];
const TRACKS = [0x16, 0x54, 0xae, 0x6b];
const webmInit = (tag, segSize = UNKNOWN) =>
  Uint8Array.from([
    ...el([0x1a, 0x45, 0xdf, 0xa3], el([0x42, 0x82], ascii('webm'))),
    0x18, 0x53, 0x80, 0x67, ...segSize,
    ...el(SEEK_HEAD, [1, 2, 3]),
    ...el([0x15, 0x49, 0xa9, 0x66], el([0x2a, 0xd7, 0xb1], [0x0f, 0x42, 0x40])), // TimecodeScale 1 ms
    ...el(TRACKS, [tag]),
  ]);
const cluster = (tc, fill, size = 1) =>
  el([0x1f, 0x43, 0xb6, 0x75], el([0xe7], [(tc >> 8) & 255, tc & 255]), el([0xa3], [0x81, 0, 0, ...new Array(size).fill(fill)]));
// First payload byte of each SimpleBlock (0xa3, 8-byte size, 3-byte block header).
const clusterFills = (bytes) => {
  const fills = [];
  for (let i = 0; i + 12 < bytes.length; i++) if (bytes[i] === 0xa3 && bytes[i + 1] === 0x01) fills.push(bytes[i + 12]);
  return fills;
};
const indexOf = (b, seq) => b.findIndex((_, i) => seq.every((x, k) => b[i + k] === x));

test('webm: clusters sorted, duplicates dropped, segment unsized, duration added, SeekHead dropped', () => {
  const chunks = [webmInit(1, [0x01, 0, 0, 0, 0, 0, 0, 0x40]), cluster(0, 1), cluster(2000, 3), cluster(1000, 2), cluster(1000, 2)];
  const { init, fragments, dropped, starts } = assembleTrack(chunks, 'video/webm; codecs="vp9"');
  assert.deepEqual(clusterFills(cat(fragments)), [1, 2, 3]);
  assert.deepEqual(starts, [0, 1, 2]);
  assert.equal(dropped, 1);
  const seg = indexOf(init, [0x18, 0x53, 0x80, 0x67]);
  assert.deepEqual([...init.subarray(seg + 4, seg + 12)], UNKNOWN);
  assert.equal(indexOf(init, SEEK_HEAD), -1);
  const d = indexOf(init, [0x44, 0x89, 0x88]);
  assert.equal(new DataView(init.buffer, init.byteOffset + d + 3, 8).getFloat64(0), 3000, '3 s in 1 ms ticks');
});

test('webm: qualities are mixed under the best init', () => {
  const chunks = [webmInit(1), cluster(0, 1), cluster(1000, 1), webmInit(2), cluster(1000, 2, 6), cluster(2000, 2, 6)];
  const { init, fragments, qualities } = assembleTrack(chunks, 'video/webm');
  assert.equal(qualities, 2);
  assert.equal(init[indexOf(init, TRACKS) + 12], 2, 'Tracks of the better quality');
  assert.deepEqual(clusterFills(cat(fragments)), [1, 2, 2]);
});

test('no init segment at all is an error', () => {
  assert.throws(() => assembleTrack([cat(frag(0, 1))], 'video/mp4'), /初始化/);
});

test('gaps: missing start, a hole in the middle, a missing end', () => {
  assert.deepEqual(gaps([20, 22, 24, 26, 28], 30), [[0, 20]]);
  assert.deepEqual(gaps([0, 2, 4, 14, 16], 18), [[6, 14]]);
  assert.deepEqual(gaps([0, 2, 4, 6], 20), [[8, 20]]);
  assert.deepEqual(gaps([0, 2, 4, 6, 8], 10), []);
  assert.deepEqual(gaps(null, 10), []);
});

// ---- muxing ----
import { muxMp4, muxable } from '../lib/fragments.js';

const fullInit = (tag, timescale) => [
  box('ftyp', ascii('isom')),
  box(
    'moov',
    box('mvhd', [0, 0, 0, 0], u32(0), u32(0), u32(1000), u32(0), new Array(76).fill(0), u32(2)),
    box(
      'trak',
      box('tkhd', [0, 0, 0, 3], u32(0), u32(0), u32(1), u32(0), u32(0)),
      box(
        'mdia',
        box('mdhd', [0, 0, 0, 0], u32(0), u32(0), u32(timescale), u32(0)),
        box('minf', box('stbl', box('stsd', [0, 0, 0, 0], u32(1), box(tag === 'v' ? 'avc1' : 'mp4a', [1])))),
      ),
    ),
    box('mvex', box('trex', [0, 0, 0, 0], u32(1), u32(1), u32(0), u32(0), u32(0))),
  ),
];

test('mux: video and audio become tracks 1 and 2, fragments interleaved by time', () => {
  const video = assembleTrack([cat(fullInit('v', 1000)), cat(frag(0, 1)), cat(frag(2000, 2)), cat(frag(4000, 3))], 'video/mp4');
  const audio = assembleTrack([cat(fullInit('a', 48000)), cat(frag(0, 11)), cat(frag(96000, 12)), cat(frag(192000, 13))], 'audio/mp4');
  assert.ok(muxable(video, audio));
  const out = muxMp4(video, audio);
  const top = mp4Boxes(out);
  assert.deepEqual(top.slice(0, 2).map((b) => b.type), ['ftyp', 'moov']);
  const moov = top[1];
  const kids = [];
  for (let i = moov.start + 8; i < moov.end; i += read32(out, i)) kids.push({ type: String.fromCharCode(...out.subarray(i + 4, i + 8)), start: i });
  assert.deepEqual(kids.map((k) => k.type), ['mvhd', 'trak', 'trak', 'mvex']);
  const mvhd = kids[0];
  assert.equal(read32(out, mvhd.start + read32(out, mvhd.start) - 4), 3, 'next_track_ID');
  const trakIds = kids.filter((k) => k.type === 'trak').map((k) => read32(out, k.start + 8 + 20));
  assert.deepEqual(trakIds, [1, 2]);
  const mvex = kids[3];
  assert.deepEqual([read32(out, mvex.start + 8 + 12), read32(out, mvex.start + 8 + 32 + 12)], [1, 2], 'trex ids');
  // fragments: v0 a0 v2 a2 v4 a4 (seconds), with track ids and sequence numbers rewritten
  const moofs = top.filter((b) => b.type === 'moof');
  const tfhdId = (m) => read32(out, m.start + 8 + 16 + 8 + 12);
  const seq = (m) => read32(out, m.start + 8 + 12);
  assert.deepEqual(moofs.map(tfhdId), [1, 2, 1, 2, 1, 2]);
  assert.deepEqual(moofs.map(seq), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(mdatFills(out), [1, 11, 2, 12, 3, 13]);
});

test('mux: not for tracks without timestamps or init extends', () => {
  const noMvex = assembleTrack([cat(init(1)), cat(frag(0, 1))], 'video/mp4');
  const audio = assembleTrack([cat(fullInit('a', 1000)), cat(frag(0, 11))], 'audio/mp4');
  assert.equal(muxable(noMvex, audio), false);
});
