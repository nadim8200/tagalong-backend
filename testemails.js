// ---------------------------------------------------------------
// Test copies of the driver-app emails, with sample data (Ferney's load 627549), sent only to ntellez@ so the user can see
// them before real ones go out: the breakdown report, a breakdown update, missing boxes at a stop, and a problem at a stop.
// Nothing is stored: no report, no road call, no push, no alarm. Admins only.
//   POST /admin/test-emails/driver-app   → { sent: [subjects] }
// ---------------------------------------------------------------
import jpeg from 'jpeg-js';
import { cleanReport, breakdownEmail } from './driverbreakdown.js';
import { cleanStopReport, stopEmail } from './stopreports.js';

const TO = 'ntellez@floridabeauty.us';

// a small solid photo (a stand-in for the driver's picture). Pure.
export function samplePhoto(r, g, b, w = 320, h = 240) {
  const data = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i += 1) { const y = Math.floor(i / w); const shade = 0.75 + 0.25 * (y / h); data[i * 4] = r * shade; data[i * 4 + 1] = g * shade; data[i * 4 + 2] = b * shade; data[i * 4 + 3] = 255; }
  return Buffer.from(jpeg.encode({ data, width: w, height: h }, 70).data);
}

// The four emails. Pure. → [{ subject, html, text, attachments }]
export function testEmails(now = Date.now()) {
  const at = new Date(now).toISOString();
  const T = { test: true, rcStatus: 'gathering' };   // the road call is still waiting for approval in the sample
  const photo = (name, rgb) => ({ name, contentType: 'image/jpeg', bytes: samplePhoto(...rgb) });
  const link = (n) => ({ id: `p${n}`, kind: 'photo', n, size: 40000, url: null });   // test photos are attached; there is no link to give
  const bk = { ...cleanReport({ status: 'stopped', part: 'trailer', category: 'tire', truck: '4504', trailer: '18094', trip: '627549', axles: 2, tires: [{ axle: 2, side: 'right', pos: 'outer' }],
    tireSize: '295/75R22.5', text: 'La llanta perdió aire. El vehículo está detenido.', more: 'Arcén angosto, tráfico pesado.', callback: '7863142671',
    location: { source: 'phone', lat: 27.44672, lng: -80.32561, at } }).report, id: 'BK-TEST-042', by: 'Ferney Urrego', driverCode: '986', at, roadCall: 'RC-TEST-517' };
  const acc = { ...cleanReport({ status: 'stopped', part: 'truck', category: 'accident', truck: '4504', trailer: '18094', trip: '627549', text: 'Un carro me pegó en el lado izquierdo al cambiar de carril.',
    answers: { hurt: 'no', others: 'yes', policeHere: 'yes', police: 'FHP 26-118734' }, callback: '7863142671', location: { source: 'phone', lat: 27.44672, lng: -80.32561, at } }).report, id: 'BK-TEST-043', by: 'Ferney Urrego', driverCode: '986', at, roadCall: 'RC-TEST-518' };
  const short = { ...cleanStopReport({ kind: 'boxes', stop: 'SOUTH WINDSOR, CT', stopName: 'FLOWERS & PRODUCE BY TERRA LLC -ANYELO', boxes: 64, pallets: 2, reportMissing: true, missing: 2, expected: 66,
    note: 'Faltan 2 cajas de rosas. El cliente lo anotó en el POD.' }).report, at };
  const prob = { ...cleanStopReport({ kind: 'problem', stop: 'CLIFTON, NJ', stopName: 'MAIN WHOLESALE FLORIST-CLIFTON', why: 'refused', note: 'Rechazaron 1 caja, llegó aplastada.' }).report, at };
  const one = (m, attachments) => ({ ...m, subject: `[TEST] ${m.subject}`, attachments });
  return [
    one(breakdownEmail(bk, [link(1), link(2)], ['p1', 'p2'], null, T), [photo('Daño.jpg', [70, 70, 75]), photo('Medida de llanta.jpg', [40, 40, 45])]),
    one(breakdownEmail(acc, [link(1)], ['p1'], null, T), [photo('Accidente.jpg', [120, 60, 50])]),
    one(breakdownEmail(bk, [link(1)], ['p1'], { text: 'Ya llegó la grúa de servicio, están cambiando la llanta.', at }, T), [photo('Servicio.jpg', [60, 90, 120])]),
    one(stopEmail(short, { test: true, trip: '627549', driver: 'Ferney Urrego', driverCode: '986', truck: '4504', trailer: '18094', links: [{ id: 'a', label: 'Photo 1', url: null }, { id: 'b', label: 'Photo 2', url: null }], attached: ['a', 'b'],
      scans: [{ paper: 'POD', bill: 'M5066106', confirmation: 'FB-482101', attached: true }], others: [] }),
    [{ name: 'POD-M5066106.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF') },
      photo('Faltante.jpg', [150, 120, 80]), photo('Pallet.jpg', [130, 110, 90])]),
    one(stopEmail(prob, { test: true, trip: '627549', driver: 'Ferney Urrego', driverCode: '986', truck: '4504', trailer: '18094', links: [{ id: 'c', label: 'Photo 1 (problem)', url: null }], attached: ['c'],
      others: [{ label: 'Earlier count', text: 'delivered 89 boxes of 90, 3 pallets' }] }), [photo('Caja dañada.jpg', [140, 100, 70])]),
  ];
}

export function initTestEmails(app, { requireAdmin, sendMail }) {
  app.post('/admin/test-emails/driver-app', requireAdmin, async (req, res) => {
    const sent = [];
    try {
      for (const m of testEmails()) { await sendMail({ to: [TO], ...m }); sent.push(m.subject); } // eslint-disable-line no-await-in-loop
      return res.json({ ok: true, to: TO, sent });
    } catch (e) { return res.status(502).json({ error: e.message, sent }); }
  });
}
