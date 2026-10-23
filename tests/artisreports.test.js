import test from 'node:test';
import assert from 'node:assert/strict';
import { pageVar, slimAssets, slimApproaching, doorTempIssues, initArtisReports } from '../artisreports.js';

const NOW = Date.parse('2026-10-22T20:00:00Z');
function memDb() { const m = new Map(); return { enabled: true, m, get: async (k, fb) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb), set: async (k, v) => m.set(k, v), update: async (k, fn, fb) => { const v = fn(m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : fb); m.set(k, v); return v; } }; }
// shaped like ARTIS (test data only)
const TRACTORS = [{ assetId: '2604', assetStatus: 'PEND', currentZoneDesc: 'HOUSTON, TX 77040', currentTrip: 625552, locationInfo: { dataSource: 'StarTrak', locationDate: NOW - 20 * 60000, location: '2M N of Houston', latitude: '29.8', longitude: '-95.5' } }, { assetId: '5091', lastLocationDateTime: 1205351167000, locationInfo: {} }];
const DOOR = [{ id: 7100, trailerNumber: '7333', doorNumber: '21', setTemp: 35, actualTemp: 64, createdBy: 'Melvis Rodriguez', createdOn: NOW - 3600000, createdOnStr: '10/22/2026 03:00 PM EDT', images: [1, 2], warehouseName: 'Miami' }, { id: 7101, trailerNumber: '7309', setTemp: 35, actualTemp: 37 }];
const page = (name, data) => `<script>\n var ${name} = ${JSON.stringify(data)}\n</script>`;

test('ARTIS page data, units seen recently, approaching yard, door temps off the set temp', () => {
  assert.deepEqual(pageVar(page('assets', [1, 2]), 'assets'), [1, 2]);
  assert.equal(pageVar('<html/>', 'assets'), null);
  const a = slimAssets(TRACTORS, NOW);
  assert.deepEqual(Object.keys(a), ['2604'], 'a 2008 position is dropped');
  assert.equal(a['2604'].lat, 29.8); assert.equal(a['2604'].source, 'StarTrak');
  const ap = slimApproaching([{ tripNumber: 625229, tripInfo: { powerUnit: '2209', originZoneDesc: 'ELIOT, ME' }, tripDestination: { callName: 'KEHE' }, legDetails: [{ bill_number: 'B180537', pieces: 3 }], stopStatus: { etaString: '10/23 06:00 AM', milesLeft: 410, hoursLate: '0', arrive_status: 'N' } }]);
  assert.deepEqual([ap[0].trip, ap[0].truck, ap[0].milesLeft, ap[0].pieces, ap[0].arrived], ['625229', '2209', 410, 3, false]);
  const d = doorTempIssues(DOOR);
  assert.equal(d.length, 1); assert.deepEqual([d[0].trailer, d[0].set, d[0].actual, d[0].photos], ['7333', 35, 64, 2]);
});

test('every 30 min: door-temp alert once (with the trip), ARTIS positions on the board, reports for Jarvis', async () => {
  const db = memDb(); const mails = [];
  const artisWeb = { ready: () => true,
    fetchJson: async (p) => (/trailer\/temps/.test(p) ? DOOR : /rejects/.test(p) ? { rejects: [{ returnedOnStr: '10/22', consigneeName: 'FALL RIVER FLORIST SUPPLY', shipperName: 'AMERICAN FLORAL CARGO', reasonTitle: 'Crushed  boxe(s)', pieces: 5, comments: [{ comment: 'Enter Comment' }] }, { consigneeName: 'OTHER', shipperName: 'X', reasonTitle: 'Wet' }] } : { kpis: { onTimePct: 100 }, groupings: { consignee: [{ name: 'STEMLINE WHOLESALE INC', stats: { avgDeliveryDays: 2 } }] }, weekdayMatrix: [] }),
    fetchText: async (p) => (/tractor/.test(p) ? page('assets', TRACTORS) : /trailer/.test(p) ? page('assets', []) : /mismatched/.test(p) ? page('tripLegs', [{ legSum: { ls_trip_number: 625145, ls_power_unit: '2209', ls_freight: 'B180474' }, stopStatus: { etaString: 'ARRIVED' } }]) : page('trips', [])) };
  const it = { trip: { tripNumber: '625549', powerUnit: '2604', trailer: '7333', destZoneDesc: 'SANTA ROSA, CA' } };
  const r = initArtisReports({ db, artisWeb, getBoard: async () => ({ trips: [it] }), sendMail: async (m) => mails.push(m), tempTeam: async () => ['dispatch@floridabeauty.us'], now: () => NOW });
  const out = await r.refresh();
  assert.equal(out.doorIssues, 1); assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /Trailer 7333 was loaded at 64°F — set 35°F \(\+29°F\) — trip 625549/);
  await r.refresh(); assert.equal(mails.length, 1, 'once per check');
  const b = { trip: { tripNumber: '625549', powerUnit: '2604', trailer: '7333' } }; await r.overlay('florida-beauty', [b]);
  assert.equal(b._artisLoc.truck.location, '2M N of Houston'); assert.equal(b._artisDoorTemp.actual, 64);
  const rej = await r.report({ which: 'warehouse_rejects', customer: 'Fall River' });
  assert.equal(rej.total, 1); assert.equal(rej.rows[0].reason, 'Crushed boxe(s)'); assert.deepEqual(rej.rows[0].comments, []);
  const perf = await r.report({ which: 'delivery_performance', customer: 'Stemline' });
  assert.equal(perf.matches[0].avgDeliveryDays, 2);
  assert.equal((await r.report({ which: 'mismatched_arrived' })).rows[0].trip, '625145');
  assert.equal((await r.report({ which: 'truck_location', truck: '02604' })).location, '2M N of Houston');
  assert.match((await r.report({ which: 'nope' })).error, /Unknown/);
});
