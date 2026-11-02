// ---------------------------------------------------------------
// Driver page scans → one light PDF for the load, like the ones in Synergize. The driver's phone straightens each page and turns it
// black and white; here each page is packed to true 1-bit (a photo of the same page is many times bigger) at 200 dpi.
// ---------------------------------------------------------------
import { deflateSync } from 'node:zlib';
import pngjs from 'pngjs';
import { PDFDocument, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } from 'pdf-lib';

const { PNG } = pngjs;
const DPI = 200;
const MAX_SIDE = 3400;
const MAX_PAGES = 8;

// RGBA → 1 bit per pixel, rows padded to whole bytes, 1 = white. Pure.
export function packBits(rgba, w, h) {
  const row = Math.ceil(w / 8);
  const out = Buffer.alloc(row * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (rgba[(y * w + x) * 4] > 127) out[y * row + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

export async function scanPdf(pages) {
  if (!pages.length || pages.length > MAX_PAGES) throw new Error(`Send 1 to ${MAX_PAGES} pages.`);
  const doc = await PDFDocument.create();
  for (const bytes of pages) {
    let png;
    try { png = PNG.sync.read(bytes); } catch { throw new Error('That scan could not be read. Scan the page again.'); }
    const { width: w, height: h } = png;
    if (w > MAX_SIDE || h > MAX_SIDE) throw new Error('That scan is too large.');
    const image = doc.context.stream(deflateSync(packBits(png.data, w, h), { level: 9 }), { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 1, Filter: 'FlateDecode' });
    const W = (w * 72) / DPI; const H = (h * 72) / DPI;
    const page = doc.addPage([W, H]);
    const name = page.node.newXObject('Scan', doc.context.register(image));
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(W, 0, 0, H, 0, 0), drawObject(name), popGraphicsState());
  }
  return Buffer.from(await doc.save());
}
