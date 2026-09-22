import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, filenameFor, formatBytes, imageFilename, sizeFromHeaders } from '../lib/media.js';

const MB = 1024 * 1024;

test('classify accepts progressive files by extension or mime', () => {
  assert.deepEqual(classify('https://a.com/v/clip.mp4?x=1', 'application/octet-stream', 5 * MB), { kind: 'file', ext: 'mp4' });
  assert.deepEqual(classify('https://a.com/stream', 'video/webm; codecs=vp9', null), { kind: 'file', ext: 'webm' });
  assert.deepEqual(classify('https://a.com/song', 'audio/mpeg', 2 * MB), { kind: 'file', ext: 'mp3' });
});

test('classify detects HLS playlists regardless of size', () => {
  assert.deepEqual(classify('https://a.com/master.m3u8', 'text/plain', 300), { kind: 'hls', ext: 'm3u8' });
  assert.deepEqual(classify('https://a.com/pl', 'application/vnd.apple.mpegurl', 300), { kind: 'hls', ext: 'm3u8' });
});

test('classify detects DASH manifests', () => {
  assert.deepEqual(classify('https://a.com/v/manifest.mpd?t=1', 'text/xml', 900), { kind: 'dash', ext: 'mpd' });
  assert.deepEqual(classify('https://a.com/v/stream', 'application/dash+xml', 900), { kind: 'dash', ext: 'mpd' });
});

test('classify rejects segments, small files and non-media', () => {
  assert.equal(classify('https://a.com/seg1.ts', 'video/mp2t', 5 * MB), null);
  assert.equal(classify('https://a.com/chunk-3.m4s', 'video/mp4', 5 * MB), null);
  assert.equal(classify('https://a.com/preview.mp4', 'video/mp4', 20_000), null);
  assert.equal(classify('https://a.com/page.html', 'text/html', 5 * MB), null);
  assert.equal(classify('blob:https://a.com/uuid', 'video/mp4', null), null);
});

test('classify detects images by mime or extension, skipping small ones', () => {
  assert.deepEqual(classify('https://a.com/p/photo.jpeg?w=1200', 'image/jpeg', 300_000), { kind: 'image', ext: 'jpg' });
  assert.deepEqual(classify('https://a.com/img/123', 'image/webp', 80_000), { kind: 'image', ext: 'webp' });
  assert.deepEqual(classify('https://a.com/a.png', 'application/octet-stream', 50_000), { kind: 'image', ext: 'png' });
  assert.deepEqual(classify('https://a.com/a.gif', '', null), { kind: 'image', ext: 'gif' });
  assert.equal(classify('https://a.com/icon.png', 'image/png', 900), null);
  assert.equal(classify('https://a.com/logo.svg', 'image/svg+xml', 50_000), null);
  assert.equal(classify('https://a.com/page.jpg', 'text/html', 50_000), null);
});

test('imageFilename keeps the image name inside a folder named after the page', () => {
  assert.equal(imageFilename('Gallery: day 1', 'https://a.com/p/IMG_0012.jpeg?x=1', 'jpg'), 'Gallery day 1/IMG_0012.jpg');
  assert.equal(imageFilename('', 'https://a.com/', 'png'), 'images/a.com.png');
  assert.equal(imageFilename('T', 'https://a.com/img/%E7%8C%AB', 'webp'), 'T/猫.webp');
});

test('sizeFromHeaders prefers the total from Content-Range', () => {
  assert.equal(sizeFromHeaders({ 'content-range': 'bytes 0-1023/987654', 'content-length': '1024' }), 987654);
  assert.equal(sizeFromHeaders({ 'content-length': '4096' }), 4096);
  assert.equal(sizeFromHeaders({ 'content-range': 'bytes 0-1023/*' }), null);
});

test('filenameFor strips characters that downloads reject', () => {
  assert.equal(filenameFor('A/B: "C"?  ', 'mp4'), 'A B C.mp4');
  assert.equal(filenameFor('...', 'mp4'), 'video.mp4');
  assert.equal(filenameFor('Show', 'ts', '720p'), 'Show [720p].ts');
});

test('formatBytes', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1.5 * MB), '1.5 MB');
  assert.equal(formatBytes(null), '');
});
