// Minimal HLS playlist parser: enough to pick a rendition and fetch its segments.

function parseAttrs(s) {
  const out = {};
  for (const m of s.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) {
    out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  }
  return out;
}

function hexToBytes(hex) {
  const clean = hex.replace(/^0x/i, '').padStart(32, '0');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// "length[@offset]"; without an offset the range continues where the previous one ended.
function parseByteRange(value, previousEnd) {
  const [len, off] = value.split('@');
  return { length: Number(len), offset: off != null ? Number(off) : previousEnd };
}

function parseMaster(lines, abs) {
  const variants = [];
  const audio = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttrs(line.slice(18));
      const uri = lines.slice(i + 1).find((l) => !l.startsWith('#'));
      if (!uri) continue;
      const [width, height] = (a.RESOLUTION || '').split('x').map(Number);
      variants.push({
        url: abs(uri),
        bandwidth: Number(a['AVERAGE-BANDWIDTH'] || a.BANDWIDTH) || 0,
        width: width || null,
        height: height || null,
        codecs: a.CODECS || '',
        audio: a.AUDIO || null,
      });
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttrs(line.slice(13));
      if (a.TYPE === 'AUDIO' && a.URI) {
        audio.push({
          group: a['GROUP-ID'],
          name: a.NAME || '',
          language: a.LANGUAGE || '',
          url: abs(a.URI),
          default: a.DEFAULT === 'YES',
        });
      }
    }
  }
  const seen = new Set();
  const unique = variants.filter((v) => !seen.has(v.url) && seen.add(v.url));
  unique.sort((x, y) => (y.height || 0) - (x.height || 0) || y.bandwidth - x.bandwidth);
  return { type: 'master', variants: unique, audio };
}

function parseMedia(lines, abs) {
  const segments = [];
  let seq = 0;
  let key = null;
  let map = null;
  let segDuration = 0;
  let range = null;
  let rangeEnd = 0;
  let duration = 0;
  let endList = false;

  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      seq = Number(line.slice(22)) || 0;
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const a = parseAttrs(line.slice(11));
      key =
        a.METHOD === 'NONE'
          ? null
          : { method: a.METHOD, url: a.URI ? abs(a.URI) : null, iv: a.IV ? hexToBytes(a.IV) : null };
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttrs(line.slice(11));
      map = { url: abs(a.URI), byteRange: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
    } else if (line.startsWith('#EXTINF:')) {
      segDuration = parseFloat(line.slice(8)) || 0;
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      range = parseByteRange(line.slice(17), rangeEnd);
    } else if (line.startsWith('#EXT-X-ENDLIST')) {
      endList = true;
    } else if (!line.startsWith('#')) {
      segments.push({ url: abs(line), duration: segDuration, seq: seq++, key, byteRange: range });
      duration += segDuration;
      if (range) rangeEnd = range.offset + range.length;
      range = null;
      segDuration = 0;
    }
  }

  const methods = [...new Set(segments.map((s) => s.key?.method).filter(Boolean))];
  return { type: 'media', segments, map, endList, duration, encryption: methods.join(',') || null };
}

export function parsePlaylist(text, baseUrl) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines[0]?.startsWith('#EXTM3U')) throw new Error('不是有效的 m3u8 播放清單');
  const abs = (u) => new URL(u, baseUrl).href;
  return lines.some((l) => l.startsWith('#EXT-X-STREAM-INF:')) ? parseMaster(lines, abs) : parseMedia(lines, abs);
}

// AES-128 IV: explicit when given, otherwise the media sequence number as a 128-bit big-endian integer.
export function ivFor(segment) {
  if (segment.key?.iv) return segment.key.iv;
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, segment.seq);
  return iv;
}

export function variantLabel(v) {
  if (v.height) return `${v.height}p`;
  if (v.bandwidth) return `${Math.round(v.bandwidth / 1000)}k`;
  return '預設';
}

// The audio rendition to fetch alongside a variant whose sound is in a separate playlist.
export function audioFor(variant, audio) {
  if (!variant.audio) return null;
  const group = audio.filter((a) => a.group === variant.audio);
  return group.find((a) => a.default) || group[0] || null;
}
