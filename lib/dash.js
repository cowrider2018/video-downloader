// Minimal MPEG-DASH (.mpd) parser: enough to list representations and, for one of them,
// the init segment and media segments to fetch. Includes a tiny XML reader because the
// service worker has no DOMParser.

// ---- XML ------------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e] ?? m,
  );

// Namespace prefixes are dropped: "cenc:pssh" -> "pssh".
const local = (name) => name.slice(name.indexOf(':') + 1);

// -> { name, attrs, children, text } for the document element.
export function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const token =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/\s*([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  for (const m of text.matchAll(token)) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      if (stack.length > 1 && top.name === local(m[2])) stack.pop();
    } else if (m[3]) {
      const attrs = {};
      for (const a of (m[4] || '').matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        attrs[local(a[1])] = decode(a[2] ?? a[3]);
      }
      const el = { name: local(m[3]), attrs, children: [], text: '' };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6]) top.text += decode(m[6]);
  }
  return root.children.find((c) => c.name) || null;
}

const kids = (el, name) => (el ? el.children.filter((c) => c.name === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;

// ---- MPD ------------------------------------------------------------------------------

// ISO 8601 duration ("PT1H2M3.5S", "P1DT2H") -> seconds.
export function parseDuration(s) {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s || '');
  if (!m) return 0;
  const [, d = 0, h = 0, min = 0, sec = 0] = m;
  return Number(d) * 86400 + Number(h) * 3600 + Number(min) * 60 + Number(sec);
}

function parseRange(r) {
  const m = /^(\d+)-(\d+)$/.exec(r || '');
  return m ? { offset: Number(m[1]), length: Number(m[2]) - Number(m[1]) + 1 } : null;
}

// Each level's BaseURL resolves against the one above it.
const withBase = (base, el) => {
  const b = kid(el, 'BaseURL');
  return b?.text.trim() ? new URL(b.text.trim(), base).href : base;
};

// "$RepresentationID$", "$Number%05d$", "$Time$", "$Bandwidth$", "$$".
function fill(template, vars) {
  return template.replace(/\$(\w*)(?:%0(\d+)d)?\$/g, (m, name, width) => {
    if (!name) return '$';
    if (!(name in vars)) return m;
    const v = String(vars[name]);
    return width ? v.padStart(Number(width), '0') : v;
  });
}

// SegmentTemplate attributes inherit from Period to AdaptationSet to Representation.
function mergedTemplate(levels) {
  let attrs = null;
  let timeline = null;
  for (const el of levels) {
    const t = kid(el, 'SegmentTemplate');
    if (!t) continue;
    attrs = { ...attrs, ...t.attrs };
    timeline = kid(t, 'SegmentTimeline') || timeline;
  }
  return attrs && { attrs, timeline };
}

function templateSegments({ attrs, timeline }, rep, base, periodDuration) {
  const timescale = Number(attrs.timescale || 1);
  const vars = { RepresentationID: rep.attrs.id, Bandwidth: rep.attrs.bandwidth };
  const init = attrs.initialization ? { url: new URL(fill(attrs.initialization, vars), base).href, byteRange: null } : null;
  const media = attrs.media;
  const segments = [];
  let number = Number(attrs.startNumber ?? 1);
  const push = (time) => segments.push({ url: new URL(fill(media, { ...vars, Number: number++, Time: time }), base).href, byteRange: null });

  if (timeline) {
    const end = periodDuration * timescale;
    let time = 0;
    for (const s of kids(timeline, 'S')) {
      if (s.attrs.t != null) time = Number(s.attrs.t);
      const d = Number(s.attrs.d);
      let r = Number(s.attrs.r || 0);
      // r = -1: repeat until the end of the period.
      if (r < 0) r = Math.max(0, Math.ceil((end - time) / d) - 1);
      for (let i = 0; i <= r; i++) {
        push(time);
        time += d;
      }
    }
  } else if (attrs.duration) {
    const count = Math.ceil((periodDuration * timescale) / Number(attrs.duration));
    for (let i = 0; i < count; i++) push((number - Number(attrs.startNumber ?? 1)) * Number(attrs.duration));
  }
  return { init, segments };
}

function listSegments(list, base) {
  const initEl = kid(list, 'Initialization');
  const init = initEl
    ? { url: new URL(initEl.attrs.sourceURL || '', base).href, byteRange: parseRange(initEl.attrs.range) }
    : null;
  const segments = kids(list, 'SegmentURL').map((s) => ({
    url: new URL(s.attrs.media || '', base).href,
    byteRange: parseRange(s.attrs.mediaRange),
  }));
  return { init, segments };
}

function kindOf(set, rep) {
  const type = rep.attrs.mimeType || set.attrs.mimeType || '';
  const content = set.attrs.contentType || type.split('/')[0];
  return content === 'video' || content === 'audio' ? content : null;
}

// -> { live, drm, duration, reps: [{ id, kind, mimeType, codecs, bandwidth, width, height }] }
// plus, for `segmentsFor(id)`, what to fetch.
export function parseMpd(text, mpdUrl) {
  const mpd = parseXml(text);
  if (!mpd || mpd.name !== 'MPD') throw new Error('不是有效的 MPD 清單');
  const live = mpd.attrs.type === 'dynamic';
  const period = kid(mpd, 'Period');
  if (!period) throw new Error('MPD 沒有任何 Period');
  const duration = parseDuration(period.attrs.duration) || parseDuration(mpd.attrs.mediaPresentationDuration);
  const mpdBase = withBase(mpdUrl, mpd);
  const periodBase = withBase(mpdBase, period);

  const reps = [];
  let drm = false;
  for (const set of kids(period, 'AdaptationSet')) {
    const setBase = withBase(periodBase, set);
    const setProtected = kids(set, 'ContentProtection').length > 0;
    for (const rep of kids(set, 'Representation')) {
      const kind = kindOf(set, rep);
      if (!kind) continue;
      const isProtected = setProtected || kids(rep, 'ContentProtection').length > 0;
      drm ||= isProtected;
      reps.push({
        id: rep.attrs.id,
        kind,
        mimeType: rep.attrs.mimeType || set.attrs.mimeType || '',
        codecs: rep.attrs.codecs || set.attrs.codecs || '',
        bandwidth: Number(rep.attrs.bandwidth) || 0,
        width: Number(rep.attrs.width || set.attrs.width) || null,
        height: Number(rep.attrs.height || set.attrs.height) || null,
        protected: isProtected,
        _el: { rep, set, base: withBase(setBase, rep) },
      });
    }
  }
  reps.sort((a, b) => (b.height || 0) - (a.height || 0) || b.bandwidth - a.bandwidth);

  const segmentsFor = (id) => {
    const r = reps.find((x) => x.id === id);
    if (!r) throw new Error('找不到這個畫質');
    const { rep, set, base } = r._el;
    const template = mergedTemplate([period, set, rep]);
    if (template) return templateSegments(template, rep, base, duration);
    const list = kid(rep, 'SegmentList') || kid(set, 'SegmentList');
    if (list) return listSegments(list, base);
    // SegmentBase or a bare BaseURL: the representation is one file.
    return { init: null, segments: [{ url: base, byteRange: null }] };
  };

  return {
    live,
    drm,
    duration,
    reps: reps.map(({ _el, ...r }) => r),
    segmentsFor,
  };
}

export function repLabel(r) {
  if (r.kind === 'video' && r.height) return `${r.height}p`;
  if (r.kind === 'audio') return `音訊 ${Math.round(r.bandwidth / 1000)}k`;
  return `${Math.round(r.bandwidth / 1000)}k`;
}

export function repExt(r) {
  const webm = r.mimeType.includes('webm');
  if (r.kind === 'audio') return webm ? 'weba' : 'm4a';
  return webm ? 'webm' : 'mp4';
}
