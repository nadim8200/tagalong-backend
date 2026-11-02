// Photos of a breakdown: from the report email, a reply on the chain, or a driver's text. They go in the email itself, small enough
// for Outlook to take. What a picture shows is for people to judge: Jarvis never writes a diagnosis from one. Pure.
import jpeg from 'jpeg-js';

export const MAX_PHOTOS = 6;
export const PHOTOS_BYTES = 1600 * 1024;     // all the photos in one email
export const EMAIL_BYTES = 2700 * 1024;      // everything in one email: what Outlook takes once encoded
const MAX_SIDE = 1400;
const SMALL = 450 * 1024;                    // already fine as it is

// the pictures in an email that Jarvis stored. Pure.
export const photosOf = (e) => ((e && e.attachments) || []).filter((a) => a && a.docId && /^image\//i.test(a.contentType || '')).slice(0, MAX_PHOTOS).map((a) => ({ docId: String(a.docId), name: String(a.name || 'photo.jpg').slice(0, 80) }));

// A phone photo says which way up it is in its EXIF: 1 normal, 3 upside down, 6 and 8 on its side. Pure.
export function exifOrientation(buf) {
  try {
    if (!buf || buf.length < 14) return 1;
    const start = buf.toString('latin1', 0, 6) === 'Exif\0\0' ? 6 : 0;
    const le = buf.toString('latin1', start, start + 2) === 'II';
    const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o)); const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
    const ifd = start + u32(start + 4);
    for (let i = 0, n = u16(ifd); i < n; i += 1) { const at = ifd + 2 + i * 12; if (u16(at) === 0x0112) return u16(at + 8) || 1; }
  } catch { /* no usable EXIF */ }
  return 1;
}

// Averages pixels down so the longest side fits, and turns it the right way up. Pure.
export function shrinkPixels({ data, width, height }, orientation = 1, maxSide = MAX_SIDE) {
  const step = Math.max(1, Math.ceil(Math.max(width, height) / maxSide));
  const w = Math.floor(width / step); const h = Math.floor(height / step);
  const turned = orientation === 6 || orientation === 8;
  const W = turned ? h : w; const H = turned ? w : h;
  const out = Buffer.alloc(W * H * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let r = 0; let g = 0; let b = 0;
      for (let j = 0; j < step; j += 1) for (let i = 0; i < step; i += 1) { const o = ((y * step + j) * width + x * step + i) * 4; r += data[o]; g += data[o + 1]; b += data[o + 2]; }
      const n = step * step;
      const [X, Y] = orientation === 6 ? [h - 1 - y, x] : orientation === 8 ? [y, w - 1 - x] : orientation === 3 ? [w - 1 - x, h - 1 - y] : [x, y];
      const o = (Y * W + X) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, width: W, height: H };
}

// A big JPEG → one that fits in an email. Anything it can't shrink comes back as it was. Pure.
export function shrinkPhoto(bytes, contentType) {
  const buf = Buffer.from(bytes);
  if (buf.length <= SMALL || !/jpe?g/i.test(contentType || '')) return { bytes: buf, contentType };
  try {
    const img = jpeg.decode(buf, { useTArray: true, maxResolutionInMP: 120, maxMemoryUsageInMB: 1024 });
    const small = shrinkPixels(img, exifOrientation(img.exifBuffer && Buffer.from(img.exifBuffer)));
    return { bytes: Buffer.from(jpeg.encode(small, 72).data), contentType: 'image/jpeg' };
  } catch (e) { console.warn('[breakdown-photos]', e.message); return { bytes: buf, contentType }; }
}

// Stored pages → the attachments that fit, each with the id the email shows it by. Pure.
export function photoAttachments(files, room = PHOTOS_BYTES) {
  const list = []; let left = room; let skipped = 0;
  for (const f of files) {
    const s = shrinkPhoto(f.data, f.mediaType);
    if (s.bytes.length > left || list.length >= MAX_PHOTOS) { skipped += 1; continue; }
    left -= s.bytes.length;
    const n = list.length + 1;
    list.push({ name: `Breakdown photo ${n}.${/png/i.test(s.contentType) ? 'png' : 'jpg'}`, contentType: s.contentType, bytes: s.bytes, cid: `bkphoto${n}` });
  }
  return { attachments: list, skipped };
}
