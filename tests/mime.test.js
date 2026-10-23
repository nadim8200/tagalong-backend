import test from 'node:test';
import assert from 'node:assert/strict';
import { mimeFiles } from '../mime.js';

const pdf = Buffer.from('%PDF-1.4 rate con B180626').toString('base64');
const inner = [
  'From: broker@arrive.com', 'Subject: Rate Confirmation', 'Content-Type: multipart/mixed; boundary="in"', '',
  '--in', 'Content-Type: text/plain', '', 'See attached.', '',
  '--in', 'Content-Type: application/octet-stream; name="RC 55120.pdf"', 'Content-Disposition: attachment; filename="RC 55120.pdf"', 'Content-Transfer-Encoding: base64', '', pdf, '',
  '--in--', '',
].join('\r\n');
const outer = [
  'From: jenniferg@floridabeauty.us', 'Subject: BATCH # 1', 'Content-Type: multipart/mixed;', ' boundary="out"', '',
  '--out', 'Content-Type: text/html', '', '<p>Thanks</p>', '',
  '--out', 'Content-Type: message/rfc822', 'Content-Disposition: attachment; filename="Fwd.eml"', '', inner, '',
  '--out', 'Content-Type: image/jpeg; name="photo.jpg"', 'Content-Transfer-Encoding: base64', '', Buffer.from('jpegbytes').toString('base64'), '',
  '--out--', '',
].join('\r\n');

test('an attached email gives up its PDFs and pictures — even an email attached inside it; body text is skipped', () => {
  const files = mimeFiles(Buffer.from(outer, 'latin1'));
  assert.deepEqual(files.map((f) => [f.name, f.contentType]), [['RC 55120.pdf', 'application/pdf'], ['photo.jpg', 'image/jpeg']]);
  assert.equal(Buffer.from(files[0].contentBytes, 'base64').toString(), '%PDF-1.4 rate con B180626');
});
