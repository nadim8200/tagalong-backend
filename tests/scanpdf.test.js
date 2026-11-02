import test from 'node:test';
import assert from 'node:assert/strict';
import pngjs from 'pngjs';
import { PDFDocument } from 'pdf-lib';
import { packBits, scanPdf } from '../scanpdf.js';

const { PNG } = pngjs;
const page = (w, h, ink = (x, y) => y % 40 < 3 && x % 7 < 5) => { const p = new PNG({ width: w, height: h }); for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) { const v = ink(x, y) ? 0 : 255; const i = (y * w + x) * 4; p.data[i] = v; p.data[i + 1] = v; p.data[i + 2] = v; p.data[i + 3] = 255; } return PNG.sync.write(p); };

test('pixels pack to one bit each, rows padded to whole bytes', () => {
  const rgba = Buffer.alloc(9 * 2 * 4, 0);
  for (const i of [0, 8, 9]) rgba[i * 4] = 255;
  assert.deepEqual([...packBits(rgba, 9, 2)], [0x80, 0x80, 0x80, 0x00]);
});

test('scanned pages become one light PDF, a letter page at 200 dpi', async () => {
  const pdf = await scanPdf([page(1700, 2200), page(1700, 2200)]);
  const doc = await PDFDocument.load(pdf);
  assert.equal(doc.getPageCount(), 2);
  assert.deepEqual(doc.getPage(0).getSize(), { width: 612, height: 792 });
  assert.ok(pdf.length < 200 * 1024, `${pdf.length} bytes`);
});

test('anything else is refused', async () => {
  await assert.rejects(scanPdf([]), /1 to 8/);
  await assert.rejects(scanPdf(Array(9).fill(page(10, 10))), /1 to 8/);
  await assert.rejects(scanPdf([Buffer.from('not a picture')]), /could not be read/);
  await assert.rejects(scanPdf([page(3500, 10)]), /too large/);
});
