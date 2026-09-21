import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDuration, parseMpd, parseXml, repExt, repLabel } from '../lib/dash.js';

test('parseXml handles attributes, namespaces, entities, comments and self-closing tags', () => {
  const el = parseXml(`<?xml version="1.0"?><!-- c --><MPD xmlns:cenc="urn:x" a='1'>
    <BaseURL>https://cdn/x?a=1&amp;b=2</BaseURL><cenc:pssh v="&lt;k&gt;"/></MPD>`);
  assert.equal(el.name, 'MPD');
  assert.equal(el.attrs.a, '1');
  assert.equal(el.children[0].text, 'https://cdn/x?a=1&b=2');
  assert.deepEqual(el.children[1], { name: 'pssh', attrs: { v: '<k>' }, children: [], text: '' });
});

test('parseDuration', () => {
  assert.equal(parseDuration('PT1H2M3.5S'), 3723.5);
  assert.equal(parseDuration('P1DT1S'), 86401);
  assert.equal(parseDuration('PT0S'), 0);
});

const TEMPLATE = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT9S">
  <BaseURL>media/</BaseURL>
  <Period>
    <AdaptationSet mimeType="video/mp4" contentType="video">
      <SegmentTemplate timescale="1000" initialization="$RepresentationID$/init.mp4" media="$RepresentationID$/seg-$Number%03d$.m4s" startNumber="5" duration="4000"/>
      <Representation id="v480" bandwidth="1000000" width="854" height="480" codecs="avc1.4d401e"/>
      <Representation id="v1080" bandwidth="5000000" width="1920" height="1080" codecs="avc1.640028"/>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" lang="en">
      <Representation id="a128" bandwidth="128000" codecs="mp4a.40.2">
        <SegmentTemplate timescale="48000" initialization="a/init.mp4" media="a/t$Time$.m4s">
          <SegmentTimeline><S t="0" d="96000" r="2"/><S d="48000"/></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

test('SegmentTemplate with $Number$ and duration, inherited from the AdaptationSet', () => {
  const mpd = parseMpd(TEMPLATE, 'https://site.example/v/manifest.mpd');
  assert.equal(mpd.live, false);
  assert.equal(mpd.drm, false);
  assert.equal(mpd.duration, 9);
  assert.deepEqual(mpd.reps.map((r) => [r.id, r.kind, repLabel(r), repExt(r)]), [
    ['v1080', 'video', '1080p', 'mp4'],
    ['v480', 'video', '480p', 'mp4'],
    ['a128', 'audio', '音訊 128k', 'm4a'],
  ]);
  const { init, segments } = mpd.segmentsFor('v1080');
  assert.equal(init.url, 'https://site.example/v/media/v1080/init.mp4');
  assert.deepEqual(
    segments.map((s) => s.url.replace('https://site.example/v/media/', '')),
    ['v1080/seg-005.m4s', 'v1080/seg-006.m4s', 'v1080/seg-007.m4s'],
  );
});

test('SegmentTemplate with SegmentTimeline and $Time$', () => {
  const { init, segments } = parseMpd(TEMPLATE, 'https://site.example/v/manifest.mpd').segmentsFor('a128');
  assert.equal(init.url, 'https://site.example/v/media/a/init.mp4');
  assert.deepEqual(
    segments.map((s) => s.url.split('/').pop()),
    ['t0.m4s', 't96000.m4s', 't192000.m4s', 't288000.m4s'],
  );
});

test('SegmentList with byte ranges, SegmentBase single file, DRM and live flags', () => {
  const mpd = parseMpd(
    `<MPD type="static" mediaPresentationDuration="PT4S"><Period>
      <AdaptationSet contentType="video" mimeType="video/webm">
        <Representation id="v" bandwidth="1" height="360">
          <BaseURL>https://cdn.example/v.webm</BaseURL>
          <SegmentList><Initialization sourceURL="v.webm" range="0-99"/>
            <SegmentURL media="v.webm" mediaRange="100-199"/><SegmentURL media="v.webm" mediaRange="200-349"/>
          </SegmentList>
        </Representation>
      </AdaptationSet>
      <AdaptationSet contentType="audio" mimeType="audio/mp4">
        <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
        <Representation id="a" bandwidth="64000"><BaseURL>a.mp4</BaseURL><SegmentBase indexRange="0-500"/></Representation>
      </AdaptationSet>
    </Period></MPD>`,
    'https://site.example/x/m.mpd',
  );
  assert.equal(mpd.drm, true);
  assert.equal(mpd.reps.find((r) => r.id === 'a').protected, true);
  assert.equal(repExt(mpd.reps[0]), 'webm');
  const v = mpd.segmentsFor('v');
  assert.deepEqual(v.init, { url: 'https://cdn.example/v.webm', byteRange: { offset: 0, length: 100 } });
  assert.deepEqual(v.segments.map((s) => s.byteRange), [
    { offset: 100, length: 100 },
    { offset: 200, length: 150 },
  ]);
  assert.deepEqual(mpd.segmentsFor('a'), { init: null, segments: [{ url: 'https://site.example/x/a.mp4', byteRange: null }] });
  assert.equal(parseMpd('<MPD type="dynamic"><Period/></MPD>', 'https://x/').live, true);
  assert.throws(() => parseMpd('<html/>', 'https://x/'));
});
