import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identityHeaders, pageHeaders } from '../lib/headers.js';

const sent = [
  { name: 'Host', value: 'cdn.example.com' },
  { name: 'Cookie', value: 'sid=abc' },
  { name: 'Referer', value: 'https://site.example.com/watch' },
  { name: 'Origin', value: 'https://site.example.com' },
  { name: 'Authorization', value: 'Bearer t' },
  { name: 'X-Token', value: 't0k' },
  { name: 'Range', value: 'bytes=0-' },
  { name: 'Sec-Fetch-Mode', value: 'cors' },
  { name: 'User-Agent', value: 'UA' },
  { name: 'Accept', value: '*/*' },
  { name: 'X-Client-Data', value: 'CIa2yQE=' },
  { name: 'X-Browser-Channel', value: 'stable' },
];

test('identityHeaders keeps identity and custom headers, drops transport ones', () => {
  assert.deepEqual(identityHeaders(sent), {
    cookie: 'sid=abc',
    referer: 'https://site.example.com/watch',
    origin: 'https://site.example.com',
    authorization: 'Bearer t',
    'x-token': 't0k',
    accept: '*/*',
  });
});

test('pageHeaders leaves out what fetch() cannot set', () => {
  assert.deepEqual(pageHeaders(identityHeaders(sent)), {
    authorization: 'Bearer t',
    'x-token': 't0k',
    accept: '*/*',
  });
});
