// Text out of Office files (PowerPoint .pptx / Word .docx) without extra packages:
// they're ZIP archives of XML. Tiny ZIP reader (stored + deflate) + XML text pull.
import { inflateRawSync } from 'zlib';

export function unzip(buf) {
  const files = {};
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('Not a ZIP / Office file.');
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10); const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28); const xlen = buf.readUInt16LE(p + 30); const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(local + 26); const lxlen = buf.readUInt16LE(local + 28);
    const data = buf.slice(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
    try { files[name] = method === 0 ? data : method === 8 ? inflateRawSync(data) : null; } catch { files[name] = null; }
    p += 46 + nlen + xlen + clen;
  }
  return files;
}
const unxml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

// .pptx → "Slide 1: …" text; .docx → paragraphs. Pure (given the bytes).
export function officeText(buf, filename = '') {
  const files = unzip(buf);
  const names = Object.keys(files);
  if (names.some((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))) {
    const slides = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    return slides.map((n, i) => {
      const x = String(files[n] || '');
      const paras = (x.match(/<a:p>[\s\S]*?<\/a:p>/g) || []).map((pp) => unxml((pp.match(/<a:t>([\s\S]*?)<\/a:t>/g) || []).map((t) => t.replace(/<\/?a:t>/g, '')).join('')).trim()).filter(Boolean);
      return `--- Slide ${i + 1} ---\n${paras.join('\n')}`;
    }).join('\n\n');
  }
  if (files['word/document.xml']) {
    const x = String(files['word/document.xml']);
    return (x.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || []).map((pp) => unxml((pp.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || []).map((t) => t.replace(/<w:t[^>]*>|<\/w:t>/g, '')).join('')).trim()).filter(Boolean).join('\n');
  }
  throw new Error(`Can't read ${filename || 'this file'} — send a PowerPoint, Word, PDF, image or text file.`);
}
