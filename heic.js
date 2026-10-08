// iPhone photos come as HEIC/HEIF, which the AI reader and most browsers can't open.
// Every file that comes in (email attachments, trip-sheet / rate-con uploads, stored
// documents) is turned into a JPEG first. Pure JS (no system libraries needed on Render).
import convert from 'heic-convert';

export const isHeic = (mediaType, filename, buf) => /hei[cf]/i.test(String(mediaType || ''))
  || /\.hei[cf]$/i.test(String(filename || ''))
  || (!!buf && buf.length > 12 && /^ftyp(heic|heix|hevc|hevx|heim|heis|mif1|msf1)/.test(buf.subarray(4, 12).toString('latin1')));

export async function heicToJpeg(buf) {
  return Buffer.from(await convert({ buffer: buf, format: 'JPEG', quality: 0.85 }));
}

// { dataBase64, mediaType, filename, … } → the same file as a JPEG when it was HEIC (else unchanged).
export async function readableFile(f) {
  if (!f || !f.dataBase64) return f;
  const buf = Buffer.from(String(f.dataBase64), 'base64');
  if (!isHeic(f.mediaType, f.filename, buf)) return f;
  try {
    const jpg = await heicToJpeg(buf);
    return { ...f, dataBase64: jpg.toString('base64'), mediaType: 'image/jpeg', filename: f.filename ? String(f.filename).replace(/\.hei[cf]$/i, '.jpg') : 'photo.jpg', convertedFrom: 'heic' };
  } catch (e) {
    console.warn('[heic] could not convert:', e.message);
    return f;
  }
}
export const readableFiles = (list = []) => Promise.all((list || []).map(readableFile));
