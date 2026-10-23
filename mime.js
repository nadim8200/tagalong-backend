// ---------------------------------------------------------------
// Files inside an attached email (.eml / Outlook "attach item"): the PDFs and pictures in its MIME parts,
// including emails attached inside that one (up to 3 deep). Pure — no network.
// ---------------------------------------------------------------
const DEPTH = 3;
const decodeWord = (v) => String(v || '').replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (m, cs, enc, txt) => {
  try { return /b/i.test(enc) ? Buffer.from(txt, 'base64').toString('utf8') : txt.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (x, h) => String.fromCharCode(parseInt(h, 16))); } catch { return m; }
});
function split(part) {
  const m = part.match(/\r?\n\r?\n/);
  if (!m) return { head: part, body: '' };
  return { head: part.slice(0, m.index).replace(/\r?\n[ \t]+/g, ' '), body: part.slice(m.index + m[0].length) };
}
const header = (head, name) => { const m = head.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'im')); return m ? m[1].trim() : ''; };
function param(v, p) {
  const star = v.match(new RegExp(`${p}\\*=(?:[^']*'[^']*')?("?)([^";]+)\\1`, 'i'));
  if (star) { try { return decodeURIComponent(star[2]); } catch { return star[2]; } }
  const m = v.match(new RegExp(`(?:^|;)\\s*${p}=("([^"]*)"|[^;\\s]+)`, 'i'));
  return m ? decodeWord(m[2] != null ? m[2] : m[1]) : '';
}
const TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff', eml: 'message/rfc822' };

// MIME text (Buffer or latin1 string) → [{ name, contentType, contentBytes (base64) }]
export function mimeFiles(raw, depth = 0, out = []) {
  const s = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw || '');
  const { head, body } = split(s);
  const ctRaw = header(head, 'Content-Type') || 'text/plain';
  const ct = ctRaw.split(';')[0].trim().toLowerCase();
  if (ct.startsWith('multipart/')) {
    const b = param(ctRaw, 'boundary');
    if (!b) return out;
    const parts = body.split(`--${b}`);
    for (const p of parts.slice(1)) { if (/^--/.test(p)) break; mimeFiles(p.replace(/^\r?\n/, ''), depth, out); }
    return out;
  }
  const enc = header(head, 'Content-Transfer-Encoding').toLowerCase();
  const bytes = () => (enc === 'base64' ? Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64') : Buffer.from(body, 'latin1'));
  const name = param(header(head, 'Content-Disposition'), 'filename') || param(ctRaw, 'name');
  const ext = (name.match(/\.([a-z0-9]+)$/i) || [])[1];
  const type = ct === 'application/octet-stream' && ext && TYPES[ext.toLowerCase()] ? TYPES[ext.toLowerCase()] : ct;
  if (type === 'message/rfc822') { if (depth < DEPTH) mimeFiles(bytes(), depth + 1, out); return out; }
  if (!name && !/^(application\/pdf|image\/)/.test(type)) return out;   // body text / html
  out.push({ name: name || `attachment-${out.length + 1}.${(type.split('/')[1] || 'bin').replace('jpeg', 'jpg')}`, contentType: type, contentBytes: bytes().toString('base64') });
  return out;
}
