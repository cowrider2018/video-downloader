// Pure helpers shared by the service worker and the popup (also run under node --test).

// Progressive files smaller than this are almost always thumbnails, previews or ad pings.
export const MIN_FILE_SIZE = 512 * 1024;

const MEDIA_EXTS = new Set([
  'mp4', 'm4v', 'webm', 'mkv', 'mov', 'flv', 'ogv', '3gp', 'avi',
  'mp3', 'm4a', 'ogg', 'oga', 'opus', 'wav', 'flac', 'aac',
]);

// Pieces of an adaptive stream; useless on their own.
const SEGMENT_EXTS = new Set(['ts', 'm4s', 'cmfv', 'cmfa']);

const MIME_EXT = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'video/x-flv': 'flv',
  'video/ogg': 'ogv',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/webm': 'weba',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
};

export function urlExt(url) {
  try {
    const m = new URL(url).pathname.match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

// Decides whether a response is something worth offering for download.
// Returns { kind: 'file' | 'hls' | 'dash', ext } or null.
export function classify(url, mime, size) {
  if (!/^https?:/i.test(url)) return null;
  const ext = urlExt(url);
  const type = (mime || '').split(';')[0].trim().toLowerCase();
  if (/mpegurl/.test(type) || ext === 'm3u8') return { kind: 'hls', ext: 'm3u8' };
  if (type.includes('dash+xml') || ext === 'mpd') return { kind: 'dash', ext: 'mpd' };
  if (type === 'video/mp2t' || type.includes('iso.segment') || SEGMENT_EXTS.has(ext)) return null;
  const known = MEDIA_EXTS.has(ext);
  if (!known && !/^(video|audio)\//.test(type)) return null;
  if (size != null && size < MIN_FILE_SIZE) return null;
  return { kind: 'file', ext: known ? ext : MIME_EXT[type] || 'mp4' };
}

// Total resource size; a 206 answer carries it after the slash in Content-Range.
export function sizeFromHeaders(headers) {
  const range = headers['content-range']?.match(/\/(\d+)\s*$/);
  if (range) return Number(range[1]);
  const len = headers['content-length'];
  return len && /^\d+$/.test(len) ? Number(len) : null;
}

// One path component the downloads API accepts: no separators, reserved characters or
// leading/trailing dots. May come back empty.
function cleanName(s) {
  return (s || '')
    .replace(/[\\/:*?"<>|~\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/^[.\s]+|[.\s]+$/g, '');
}

export function filenameFor(title, ext, tag = '') {
  let base = cleanName(title);
  if (!base) base = 'video';
  if (tag) base += ` [${tag}]`;
  return `${base}.${ext}`;
}

export function displayName(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : u.hostname;
  } catch {
    return url;
  }
}

export function formatBytes(n) {
  if (n == null) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i && n < 10 ? 1 : 0)} ${units[i]}`;
}
