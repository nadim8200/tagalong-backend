import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTripStatus, slimStatus, etaSlotDue, initArtisWeb } from '../artisweb.js';
import { initJarvisChat } from '../jarvischat.js';

// shaped like ARTIS's Trip Status page (test data only)
const STATUS = { destinationClient: { clientId: '09273', name: 'WESTLAND FLORAL', city: 'CARPINTERIA', state: 'CA', postalCode: '93013' }, powerUnit: '2604', trailer: '7309', tripNumber: 625552, countInfo: { boxesQty: 101, boxesCubes: 195.6, palletsQty: 0 }, siteDisplayName: 'FLORIDA',
  driver1: { driverName: 'X', cellPhone: '786-000-0000' }, tripStatusDetails: [{}, {}], tripStatusInfo: { currentLocation: 'Houston TX', milesToDestination: 1680, etaLong: 1792838049000, etaDateTimeStr: '10/24/2026 06:34 AM Local Time', gpsPingDate: 1792717308000, gpsPingDateStr: '10/22/2026 09:01 PM EDT', arrived: false, delivered: false },
  arrived: false, delivered: false, truckSeqno: 'CA-000026335', warehouseInfo: { warehouseId: 3, warehouseName: 'Miami' } };
const PAGE = `<script>\n    var stops = ${JSON.stringify([{ clientId: '09273', clientName: 'WESTLAND FLORAL', tripStatuses: [STATUS] }])}\n\n    var selectedClient = '09273';\n</script>`;

test('Trip Status page → ARTIS ETA, miles, location, GPS time — no driver names or phones', () => {
  const stops = parseTripStatus(PAGE);
  const s = slimStatus(stops[0].tripStatuses[0], '09273');
  assert.equal(s.trip, '625552'); assert.equal(s.etaMs, 1792838049000); assert.equal(s.etaText, '10/24/2026 06:34 AM Local Time');
  assert.equal(s.miles, 1680); assert.equal(s.location, 'Houston TX'); assert.equal(s.boxes, 101); assert.equal(s.route, 'CA-000026335');
  assert.equal(JSON.stringify(s).includes('786-'), false);
  assert.equal(parseTripStatus('<html>login</html>'), null);
});

test('read twice a day: 10 AM and 4 PM Miami time, once each', () => {
  assert.equal(etaSlotDue({}, Date.parse('2026-10-22T13:00:00Z')), null);                   // 9 AM ET
  assert.equal(etaSlotDue({}, Date.parse('2026-10-22T14:05:00Z')), '2026-10-22|am');
  assert.equal(etaSlotDue({ done: { '2026-10-22|am': 'x' } }, Date.parse('2026-10-22T15:00:00Z')), null);
  assert.equal(etaSlotDue({ done: { '2026-10-22|am': 'x' } }, Date.parse('2026-10-22T20:10:00Z')), '2026-10-22|pm');
});

function memDb() { const m = new Map(); return { enabled: true, m, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } }; }
const ITEM = { trip: { tripNumber: '625552', powerUnit: '2604' }, _tb: { date: '2026-10-19', stops: [{ consigneeId: '09273', consignee: 'WESTLAND FLORAL', city: 'CARPINTERIA', state: 'CA' }, { consigneeId: '13363', consignee: "SPEDALE'S FLORIST INC *", city: 'BROUSSARD', state: 'LA' }] } };
function fakeArtis(calls) {
  return async (url, opts = {}) => {
    calls.push(url);
    if (/\/login/.test(url)) return { status: 302, ok: false, headers: { getSetCookie: () => ['JSESSIONID=abc; Path=/'] }, text: async () => '' };
    if (/\/shipment\/eta/.test(url)) return { status: 200, ok: true, headers: { get: () => 'text/html' }, text: async () => PAGE };
    if (/manifest\/print\/detail/.test(url)) return { status: 200, ok: true, headers: { get: () => 'application/pdf' }, arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4 test').buffer };
    return { status: 404, ok: false, headers: { get: () => '' }, text: async () => '' };
  };
}

test('twice-a-day read stores ARTIS ETAs per trip + customer; the manifest PDF is fetched once and kept on the trip', async () => {
  const db = memDb(); const calls = []; const stored = [];
  const routes = {}; const app = { get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); } };
  const docs = { storeDocs: async ({ files, trip, kind }) => { stored.push({ trip, kind, name: files[0].filename }); return [{ id: 77 }]; } };
  const w = initArtisWeb(app, { requireAuth: (q, r, n) => n(), db, docs, env: { ARTIS_WEB_USER: 'u', ARTIS_WEB_PASSWORD: 'p' }, getBoard: async () => ({ trips: [ITEM] }), fetchFn: fakeArtis(calls), now: () => Date.parse('2026-10-22T14:05:00Z') });
  const r = await w.readEtas();
  assert.equal(r.customers, 2); assert.equal(r.trips, 1);
  const it = { trip: { tripNumber: '625552' } }; await w.overlay('florida-beauty', [it]);
  assert.equal(it._artisEta.stops[0].etaText, '10/24/2026 06:34 AM Local Time');
  assert.equal(calls.filter((u) => /\/login/.test(u)).length, 1, 'one sign-in for the whole read');
  const d = await w.manifestDoc({ item: ITEM, clientId: '09273', kind: 'detail', by: 'Rosa' });
  assert.deepEqual([d.id, d.name], ['77', 'Trip-Manifest-Detail-625552-09273.pdf']);
  assert.deepEqual(stored[0], { trip: '625552', kind: 'manifest', name: 'Trip-Manifest-Detail-625552-09273.pdf' });
  assert.equal((await w.manifestDoc({ item: ITEM, clientId: '09273' })).reused, true, 'same day → the stored copy');
  assert.match(calls.find((u) => /manifest/.test(u)), /clientId=09273&tripNumber=625552/);
  // Ask Jarvis: "send me Westland's manifest" → attached; a customer email only for its own business
  const chat = initJarvisChat({ get: () => {}, post: () => {} }, { requireAuth: (q, r2, n) => n(), db, artisWeb: w, getBoard: async () => ({ trips: [ITEM] }), env: { ANTHROPIC_API_KEY: 'k' } });
  const ctx = { user: { id: 7, name: 'Rosa' }, did: [], proposed: [] };
  const m = await chat.runTool('trip_manifest', { customer: 'Westland Floral' }, ctx);
  assert.equal(m.manifests[0].attached, 'Trip-Manifest-Detail-625552-09273.pdf'); assert.deepEqual(ctx.docs, [{ id: '77', name: 'Trip-Manifest-Detail-625552-09273.pdf' }]);
  const other = await chat.runTool('trip_manifest', { customer: 'Westland Floral' }, { ...ctx, customer: true, senderClient: "SPEDALE'S FLORIST INC" });
  assert.equal(other.found, false, 'a customer never gets another customer\'s manifest');
  const own = await chat.runTool('trip_manifest', { customer: "Spedale's" }, { ...ctx, docs: [], customer: true, senderClient: "SPEDALE'S FLORIST INC" });
  assert.equal(own.found, true);
});

import { parseConsignee, pickConsignee } from '../artisweb.js';
test('ARTIS customer list: a stop\'s customer number by name, the right city when several match', () => {
  const list = [{ value: '02281', text: 'DESIGNERS CHOICE BOSTON - 02281 - BOSTON, MA', clientName: 'DESIGNERS CHOICE BOSTON' }, { value: '51299', text: "DESIGNER'S CHOICE KY - 51299 - LOUISVILLE, KY", clientName: "DESIGNER'S CHOICE KY" }, { value: '02530', text: "DESIGNER'S CHOICE PA - 02530 - MECHANICSBURG, PA", clientName: "DESIGNER'S CHOICE PA" }].map(parseConsignee);
  assert.deepEqual(list[0], { id: '02281', name: 'DESIGNERS CHOICE BOSTON', city: 'BOSTON', state: 'MA' });
  assert.equal(pickConsignee(list, { name: 'DESIGNERS CHOICE BOSTON', city: 'BOSTON', state: 'MA' }), '02281');
  assert.equal(pickConsignee(list, { name: "Designer's Choice PA", city: 'Mechanicsburg' }), '02530');
  assert.equal(pickConsignee(list, { name: 'Zoom Bloom' }), null);
});
