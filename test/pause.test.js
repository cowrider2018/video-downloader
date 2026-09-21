import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { fetchFile, makeGate, runHlsJob } from '../lib/jobs.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A fake server streaming `data` in 1 KB chunks, 5 ms apart, honouring Range and abort.
function fileServer(data, { ranges = true } = {}) {
  const requests = [];
  const fetchImpl = async (url, { headers = {}, signal } = {}) => {
    requests.push(headers.Range || 'full');
    const from = ranges && headers.Range ? Number(headers.Range.match(/bytes=(\d+)-/)[1]) : 0;
    const body = data.subarray(from);
    let pos = 0;
    const stream = new ReadableStream({
      async pull(ctl) {
        await sleep(5);
        if (signal?.aborted) return ctl.error(new DOMException('aborted', 'AbortError'));
        if (pos >= body.length) return ctl.close();
        ctl.enqueue(new Uint8Array(body.subarray(pos, pos + 1024)));
        pos += 1024;
      },
    });
    const partial = from > 0;
    return new Response(stream, {
      status: partial ? 206 : 200,
      headers: {
        'content-length': String(body.length),
        ...(partial ? { 'content-range': `bytes ${from}-${data.length - 1}/${data.length}` } : {}),
      },
    });
  };
  return { fetchImpl, requests };
}

test('fetchFile resumes a paused download with a Range request', async () => {
  const data = randomBytes(40 * 1024);
  const { fetchImpl, requests } = fileServer(data);
  const gate = makeGate();
  let seen = 0;
  const done = fetchFile('https://x/f.mp4', { fetchImpl, gate, onProgress: (p) => (seen = p.bytes) });
  while (seen < 8 * 1024) await sleep(5);
  gate.pause();
  await sleep(40);
  const frozen = seen;
  await sleep(40);
  assert.equal(seen, frozen, 'no bytes arrive while paused');
  gate.resume();
  const blob = await done;
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), data);
  assert.equal(requests[0], 'full');
  assert.match(requests[1], /^bytes=\d+-$/);
});

test('fetchFile starts over when the server ignores Range', async () => {
  const data = randomBytes(20 * 1024);
  const { fetchImpl } = fileServer(data, { ranges: false });
  const gate = makeGate();
  let seen = 0;
  const done = fetchFile('https://x/f.mp4', { fetchImpl, gate, onProgress: (p) => (seen = p.bytes) });
  while (seen < 4 * 1024) await sleep(5);
  gate.pause();
  await sleep(20);
  gate.resume();
  assert.deepEqual(Buffer.from(await (await done).arrayBuffer()), data);
});

test('runHlsJob holds between segments while paused', async () => {
  const segs = Array.from({ length: 60 }, () => randomBytes(500));
  const playlist = ['#EXTM3U', ...segs.flatMap((_, i) => ['#EXTINF:1,', `s${i}.ts`]), '#EXT-X-ENDLIST'].join('\n');
  let fetched = 0;
  const fetchBytes = async (url) => {
    if (url.endsWith('.m3u8')) return new TextEncoder().encode(playlist);
    await sleep(10);
    fetched++;
    return new Uint8Array(segs[Number(url.match(/s(\d+)\.ts/)[1])]);
  };
  const gate = makeGate();
  const done = runHlsJob('https://x/p.m3u8', { fetchBytes, gate });
  while (fetched < 2) await sleep(2);
  gate.pause();
  await sleep(30); // let in-flight segments land
  const frozen = fetched;
  await sleep(60);
  assert.equal(fetched, frozen, 'no new segments while paused');
  assert.ok(frozen < segs.length);
  gate.resume();
  const { blob } = await done;
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), Buffer.concat(segs));
});
