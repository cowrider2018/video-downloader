import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { runHlsJob } from '../lib/hls-job.js';

const BASE = 'https://cdn.example.com/v/';

function fixture({ encrypted = true, live = false } = {}) {
  const key = randomBytes(16);
  const plain = [randomBytes(1000), randomBytes(1500), randomBytes(700)];
  const files = new Map();
  const lines = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:5'];
  if (encrypted) lines.push('#EXT-X-KEY:METHOD=AES-128,URI="k.bin"');
  plain.forEach((p, i) => {
    let body = p;
    if (encrypted) {
      const iv = Buffer.alloc(16);
      iv.writeUInt32BE(5 + i, 12);
      const c = createCipheriv('aes-128-cbc', key, iv);
      body = Buffer.concat([c.update(p), c.final()]);
    }
    files.set(`${BASE}s${i}.ts`, body);
    lines.push('#EXTINF:2,', `s${i}.ts`);
  });
  if (!live) lines.push('#EXT-X-ENDLIST');
  files.set(`${BASE}media.m3u8`, Buffer.from(lines.join('\n')));
  files.set(`${BASE}k.bin`, key);
  files.set(
    `${BASE}master.m3u8`,
    Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=2x2\nmedia.m3u8\n'),
  );
  const requested = [];
  const fetchBytes = async (url) => {
    requested.push(url);
    if (!files.has(url)) throw new Error(`404 ${url}`);
    return new Uint8Array(files.get(url));
  };
  return { plain, fetchBytes, requested };
}

test('downloads, decrypts and concatenates a stream reached through its master', async () => {
  const { plain, fetchBytes, requested } = fixture();
  const seen = [];
  const progress = [];
  const { blob, ext } = await runHlsJob(`${BASE}master.m3u8`, {
    fetchBytes,
    onProgress: (p) => progress.push(p),
    beforeFetch: async (urls) => seen.push(...urls),
  });
  assert.equal(ext, 'ts');
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), Buffer.concat(plain));
  assert.equal(requested.filter((u) => u.endsWith('k.bin')).length, 1, 'key fetched once');
  assert.ok(seen.includes(`${BASE}s2.ts`), 'segment hosts announced before fetching');
  assert.deepEqual(progress.at(-1), { done: 3, total: 3, bytes: 3200 });
});

test('refuses live streams', async () => {
  const { fetchBytes } = fixture({ live: true });
  await assert.rejects(runHlsJob(`${BASE}media.m3u8`, { fetchBytes }), /直播/);
});

test('stops when aborted', async () => {
  const { fetchBytes } = fixture({ encrypted: false });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runHlsJob(`${BASE}media.m3u8`, { fetchBytes, signal: controller.signal }), /已取消/);
});
