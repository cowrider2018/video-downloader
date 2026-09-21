import assert from 'node:assert/strict';
import { test } from 'node:test';
import { audioFor, ivFor, parsePlaylist, variantLabel } from '../lib/hls.js';

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="subs/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud"
360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5000000,AVERAGE-BANDWIDTH=4500000,RESOLUTION=1920x1080,AUDIO="aud"
https://cdn.example.com/1080/index.m3u8?token=abc
#EXT-X-STREAM-INF:BANDWIDTH=64000
audio-only.m3u8
`;

test('master playlist: variants sorted best first with absolute URLs', () => {
  const pl = parsePlaylist(MASTER, 'https://site.example.com/hls/master.m3u8');
  assert.equal(pl.type, 'master');
  assert.deepEqual(
    pl.variants.map((v) => [v.height, v.bandwidth, v.url]),
    [
      [1080, 4500000, 'https://cdn.example.com/1080/index.m3u8?token=abc'],
      [360, 800000, 'https://site.example.com/hls/360/index.m3u8'],
      [null, 64000, 'https://site.example.com/hls/audio-only.m3u8'],
    ],
  );
  assert.deepEqual(pl.variants.map(variantLabel), ['1080p', '360p', '64k']);
  assert.equal(audioFor(pl.variants[0], pl.audio).url, 'https://site.example.com/hls/audio/en.m3u8');
  assert.equal(audioFor(pl.variants[2], pl.audio), null);
  assert.deepEqual(pl.subtitles, ['https://site.example.com/hls/subs/en.m3u8']);
});

const MEDIA = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:7
#EXTINF:6.0,
seg7.ts
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x000102030405060708090a0b0c0d0e0f
#EXTINF:5.5,
seg8.ts
#EXT-X-KEY:METHOD=AES-128,URI="key2.bin"
#EXTINF:4,
seg9.ts
#EXT-X-ENDLIST
`;

test('media playlist: segments, keys, sequence numbers and IVs', () => {
  const pl = parsePlaylist(MEDIA, 'https://a.com/v/index.m3u8');
  assert.equal(pl.type, 'media');
  assert.equal(pl.endList, true);
  assert.equal(pl.duration, 15.5);
  assert.equal(pl.encryption, 'AES-128');
  assert.deepEqual(pl.segments.map((s) => s.seq), [7, 8, 9]);
  assert.equal(pl.segments[0].key, null);
  assert.equal(pl.segments[1].key.url, 'https://a.com/v/key.bin');
  assert.deepEqual([...ivFor(pl.segments[1])], [...Array(16).keys()]);
  assert.deepEqual([...ivFor(pl.segments[2])], [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9]);
});

test('fMP4 playlist with init map and byte ranges', () => {
  const pl = parsePlaylist(
    `#EXTM3U
#EXT-X-MAP:URI="main.mp4",BYTERANGE="720@0"
#EXTINF:4,
#EXT-X-BYTERANGE:1000@720
main.mp4
#EXTINF:4,
#EXT-X-BYTERANGE:2000
main.mp4
`,
    'https://a.com/x/p.m3u8',
  );
  assert.deepEqual(pl.map, { url: 'https://a.com/x/main.mp4', byteRange: { length: 720, offset: 0 } });
  assert.deepEqual(pl.segments.map((s) => s.byteRange), [
    { length: 1000, offset: 720 },
    { length: 2000, offset: 1720 },
  ]);
  assert.equal(pl.endList, false);
});

test('rejects non-playlists', () => {
  assert.throws(() => parsePlaylist('<html>', 'https://a.com/'));
});
