// ---------------------------------------------------------------
// The rest of ARTIS (floridabeauty.com), read-only with the same web login (artisweb.js):
//  • every 30 min: trailer temps at the loading door (alert when a trailer was loaded far off its set temp),
//    tractor + trailer locations (a second GPS source when Samsara is stale), trucks approaching the yards.
//  • on demand (Jarvis): box temps at receiving, warehouse rejects, wrong-pallet boxes, boxes not built,
//    mismatched arrivals, delivery performance, Synergize documents (PODs) on a trip.
// Driver names / phones and staff e-mails from ARTIS are never kept.
// ---------------------------------------------------------------
const SITE = 'florida-beauty';
const KEY = `taArtisReports:${SITE}`;
const SENT = `taArtisDoorTempSent:${SITE}`;
const MIN = 60000;
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const unit = (x) => String(x == null ? '' : x).trim().replace(/^0+(?=\d)/, '').toUpperCase();
const ymd = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const mdy = (d) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;   // 2026-10-22 → 10/22/2026
export const DOOR_TEMP_DIFF = 8;   // °F off the set temp at the loading door → alert

// `var name = …` on one line of an ARTIS page → its data, or null. Pure.
export function pageVar(html, name) {
  const s = String(html || '');
  const k = s.indexOf(`var ${name}`);
  if (k < 0) return null;
  const eq = s.indexOf('=', k); const end = s.indexOf('\n', eq);
  try { return JSON.parse(s.slice(eq + 1, end < 0 ? undefined : end).trim().replace(/;$/, '')); } catch { return null; }
}
// Tractor / trailer locations → only units seen in the last 14 days, small. Pure.
export function slimAssets(list, now = Date.now()) {
  const out = {};
  for (const a of Array.isArray(list) ? list : []) {
    const li = a.locationInfo || {};
    const at = Number(li.locationDate || a.lastSatDateTime || a.lastLocationDateTime) || null;
    if (!at || now - at > 14 * 24 * 60 * MIN) continue;
    const lat = Number(li.latitude || a.lastLatitude); const lng = Number(li.longitude || a.lastLongitude);
    out[unit(a.assetId)] = { at, location: li.location || a.lastSatLocation || a.currentZoneDesc || null, zone: a.currentZoneDesc || null, lat: Number.isFinite(lat) && lat ? lat : null, lng: Number.isFinite(lng) && lng ? lng : null, source: li.dataSource || null, trip: a.currentTrip || null, status: a.assetStatus || null };
  }
  return out;
}
// Approaching Yard → inbound trips with ARTIS's ETA / miles left / hours late. Pure.
export function slimApproaching(trips) {
  return (Array.isArray(trips) ? trips : []).map((t) => {
    const ti = t.tripInfo || {}; const ss = t.stopStatus || {}; const d = t.tripDestination || {};
    const bills = (t.legDetails || []).map((l) => l.bill_number).filter(Boolean);
    return { trip: String(t.tripNumber), truck: ti.powerUnit || null, trailer: ti.trailer || null, from: ti.originZoneDesc || null, to: d.callName || ti.descZoneDesc || null, now: ti.currentZoneDesc || null, eta: ss.etaString || ss.eta || null, milesLeft: ss.milesLeft ?? null, hoursLate: ss.hoursLate || null, arrived: ss.arrive_status === 'Y', pinged: ss.pingDate || null, bills: bills.slice(0, 20), pieces: (t.legDetails || []).reduce((n, l) => n + (Number(l.pieces) || 0), 0) };
  });
}
// Trailer temps at the loading door: which are off by more than `diff` °F. Pure.
export function doorTempIssues(rows, diff = DOOR_TEMP_DIFF) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.setTemp != null && r.actualTemp != null && Math.abs(Number(r.actualTemp) - Number(r.setTemp)) > diff)
    .map((r) => ({ id: r.id, trailer: unit(r.trailerNumber), door: r.doorNumber || null, set: Number(r.setTemp), actual: Number(r.actualTemp), at: r.createdOn || null, atText: r.createdOnStr || null, by: r.createdBy || null, warehouse: r.warehouseName || null, photos: (r.images || []).length, images: (r.images || []).slice(0, 4) }));
}
const fits = (q, name) => { const w = String(q || '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter((x) => x.length > 2); const n = String(name || '').toUpperCase(); return !w.length || w.every((x) => n.includes(x)); };

export function initArtisReports({ db, artisWeb, getBoard = null, sendMail = null, tempTeam = async () => [], env = process.env, now = () => Date.now() }) {
  const enabled = () => !!(db && db.enabled && artisWeb && artisWeb.ready && artisWeb.ready());
  const diff = Number(env.ARTIS_DOOR_TEMP_DIFF) || DOOR_TEMP_DIFF;

  // every 30 min: door temps (alert), unit locations, approaching yard
  async function refresh() {
    const today = ymd(now()); const yday = ymd(now() - 86400000);
    const out = { at: new Date(now()).toISOString() }; const errors = [];
    try { out.doorTemps = await artisWeb.fetchJson(`/artis-app/trailer/temps?startDate=${yday}&endDate=${today}`); } catch (e) { errors.push(`door temps: ${e.message}`); }
    try { out.tractors = slimAssets(pageVar(await artisWeb.fetchText('/reports/tractorLocations'), 'assets'), now()); } catch (e) { errors.push(`tractors: ${e.message}`); }
    try { out.trailers = slimAssets(pageVar(await artisWeb.fetchText('/reports/trailerLocations'), 'assets'), now()); } catch (e) { errors.push(`trailers: ${e.message}`); }
    out.approaching = {};
    for (const hub of ['Florida', 'California']) {
      try { out.approaching[hub] = slimApproaching(pageVar(await artisWeb.fetchText(`/reports/approachingYard/${hub}`), 'trips')); } catch (e) { errors.push(`approaching ${hub}: ${e.message}`); } // eslint-disable-line no-await-in-loop
    }
    out.doorIssues = doorTempIssues((out.doorTemps || []).map((r) => ({ ...r, createdBy: r.createdBy })), diff);
    delete out.doorTemps;
    out.errors = errors;
    await db.set(KEY, out);
    await alertDoorTemps(out.doorIssues);
    return { tractors: Object.keys(out.tractors || {}).length, trailers: Object.keys(out.trailers || {}).length, approaching: Object.values(out.approaching).reduce((n, l) => n + l.length, 0), doorIssues: out.doorIssues.length, errors };
  }
  // a trailer loaded far off its set temp → one email to the reefer temperature list (with the trip when we have it)
  async function alertDoorTemps(issues) {
    if (!issues.length || !sendMail) return;
    const sent = (await db.get(SENT, {})) || {};
    const fresh = issues.filter((x) => !sent[x.id]);
    if (!fresh.length) return;
    const items = getBoard ? (((await getBoard(SITE)) || {}).trips || []) : [];
    const to = await tempTeam();
    for (const x of fresh) {
      const it = items.find((i) => unit(tripOf(i).trailer) === x.trailer);
      const t = it ? tripOf(it) : null;
      const what = `Trailer ${x.trailer} was loaded at ${x.actual}°F — set ${x.set}°F (${x.actual > x.set ? '+' : ''}${x.actual - x.set}°F)`;
      const lines = [what, `${x.warehouse || 'Warehouse'} door ${x.door || '—'} · ${x.atText || ''}${x.by ? ` · checked by ${x.by}` : ''}${x.photos ? ` · ${x.photos} photo${x.photos === 1 ? '' : 's'} in ARTIS` : ''}`, t ? `Trip ${tripNo(it)} · truck ${t.powerUnit || '—'} → ${t.destZoneDesc || ''}` : 'No active trip on this trailer yet.', 'Check the reefer before it rolls (or with the driver if it already left). Source: ARTIS Trailer Temp Verifications.'];
      if (to.length) {
        // the dock's photos (thermometer / reefer display) — shown inside the email body
        const pics = [];
        for (const id of x.images || []) {
          try {
            const p = await artisWeb.fetchBuffer(`/artis-app/trailer/temp/image/${encodeURIComponent(id)}`); // eslint-disable-line no-await-in-loop
            const jpg = p.buf[0] === 0xff && p.buf[1] === 0xd8;
            if (p.buf.length > 100) pics.push({ name: `trailer-${x.trailer}-photo-${pics.length + 1}.${jpg ? 'jpg' : 'png'}`, contentType: jpg ? 'image/jpeg' : 'image/png', bytes: p.buf, cid: `door${id}` });
          } catch (e) { console.warn('[artis-door-temp] photo', id, e.message); }
        }
        const esc = (l) => String(l).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
        const imgs = pics.map((p) => `<img src="cid:${p.cid}" alt="Door temperature photo" style="display:block;width:420px;max-width:100%;border-radius:6px;margin:8px 0">`).join('');
        try { await sendMail({ to, subject: `Reefer: ${what}${t ? ` — trip ${tripNo(it)}` : ''}`, html: `<div style="font-family:Arial,sans-serif;font-size:14px">${lines.map((l) => `<div>${esc(l)}</div>`).join('')}${imgs}<p>— Jarvis</p></div>`, attachments: pics }); } catch (e) { console.warn('[artis-door-temp]', e.message); } // eslint-disable-line no-await-in-loop
      }
      sent[x.id] = new Date(now()).toISOString();
    }
    await db.set(SENT, Object.fromEntries(Object.entries(sent).slice(-500)));
  }
  // on the board: ARTIS's position for the truck / trailer, and a door-temp warning on its trailer
  async function overlay(site, trips) {
    if (!(db && db.enabled)) return;
    const st = (await db.get(KEY, {})) || {};
    for (const it of trips) {
      const t = tripOf(it);
      const tr = st.tractors && st.tractors[unit(t.powerUnit)];
      const tl = st.trailers && st.trailers[unit(t.trailer)];
      if (tr || tl) it._artisLoc = { truck: tr || null, trailer: tl || null };
      const door = (st.doorIssues || []).filter((x) => x.trailer === unit(t.trailer));
      if (door.length) it._artisDoorTemp = door[door.length - 1];
    }
  }

  // Jarvis: the on-demand reports (dates YYYY-MM-DD, default today; optional customer / truck / trailer / hub filter)
  async function report({ which, from, to, customer, truck, trailer, hub, trip } = {}) {
    const d1 = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? from : ymd(now() - (/(performance|rejects|wrong|temp_alerts)/.test(which) ? 6 : 0) * 86400000);
    const d2 = /^\d{4}-\d{2}-\d{2}$/.test(String(to || '')) ? to : ymd(now());
    const st = (await db.get(KEY, {})) || {};
    const cut = (l, n = 40) => ({ total: l.length, rows: l.slice(0, n), more: Math.max(0, l.length - n) || undefined });
    switch (which) {
      case 'approaching_yard': {
        const l = [...(hub && /cal/i.test(hub) ? [] : (st.approaching || {}).Florida || []).map((x) => ({ ...x, yard: 'Miami' })), ...(hub && /fl|mia/i.test(hub) ? [] : (st.approaching || {}).California || []).map((x) => ({ ...x, yard: 'California' }))];
        return { asOf: st.at || null, ...cut(l.filter((x) => (!truck || unit(x.truck) === unit(truck)) && (!trip || x.trip === String(trip)))) };
      }
      case 'truck_location': case 'trailer_location': {
        const set = which === 'truck_location' ? st.tractors : st.trailers; const id = unit(which === 'truck_location' ? truck : trailer);
        const x = set && set[id];
        return x ? { asOf: st.at, unit: id, ...x, atText: new Date(x.at).toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET' } : { found: false, note: `ARTIS has no recent position for ${id || 'that unit'}.` };
      }
      case 'door_temps': {
        const rows = await artisWeb.fetchJson(`/artis-app/trailer/temps?startDate=${d1}&endDate=${d2}`);
        const l = (rows || []).filter((r) => !trailer || unit(r.trailerNumber) === unit(trailer)).map((r) => ({ trailer: r.trailerNumber, door: r.doorNumber, set: r.setTemp, actual: r.actualTemp, at: r.createdOnStr, warehouse: r.warehouseName, offBy: r.actualTemp != null && r.setTemp != null ? r.actualTemp - r.setTemp : null }));
        return { from: d1, to: d2, ...cut(l) };
      }
      case 'temp_alerts': {
        const j = await artisWeb.fetchJson(`/edi/temp_alerts/get?startDate=${mdy(d1)}&endDate=${mdy(d2)}`);
        const l = (j.dataset || []).filter((r) => fits(customer, r.consigneeName) || fits(customer, r.shipperName)).map((r) => ({ at: r.createdOnStr, consignee: r.consigneeName, shipper: r.shipperName, temp: `${r.temp}°${r.tempUnit || 'F'}`, pieces: r.pieces, photos: r.imageCount, warehouse: (r.warehouseInfo || {}).warehouseName }));
        return { from: d1, to: d2, note: 'Box temperatures taken at receiving in the warehouse.', ...cut(l) };
      }
      case 'warehouse_rejects': {
        const j = await artisWeb.fetchJson(`/edi/rejects/get?startDate=${mdy(d1)}&endDate=${mdy(d2)}`);
        const l = (j.rejects || []).filter((r) => fits(customer, r.consigneeName) || fits(customer, r.shipperName)).map((r) => ({ at: r.returnedOnStr, consignee: r.consigneeName, shipper: r.shipperName, reason: String(r.reasonTitle || '').replace(/\s+/g, ' ').trim(), pieces: r.pieces, packType: r.packType, photos: r.imageCount, warehouse: r.warehouseName, comments: (r.comments || []).map((c) => c.comment).filter((c) => c && !/^enter comment$/i.test(c)) }));
        return { from: d1, to: d2, note: 'Boxes rejected / returned at the warehouse (crushed, wet, wrong…).', ...cut(l) };
      }
      case 'wrong_boxes': {
        const j = await artisWeb.fetchJson(`/pallet/wrong_boxes/get?startDate=${mdy(d1)}&endDate=${mdy(d2)}`);
        const l = (j.boxList || []).filter((r) => fits(customer, r.scannedConsigneeName) || fits(customer, r.palletConsigneeName)).map((r) => ({ at: r.createdOnStr, box: r.boxNo, boxFor: r.scannedConsigneeName, putOnPalletFor: r.palletConsigneeName, warehouse: (r.warehouseInfo || {}).warehouseName }));
        return { from: d1, to: d2, note: 'Boxes scanned onto another customer\'s pallet.', ...cut(l) };
      }
      case 'not_built': {
        const j = await artisWeb.fetchJson(`/edi/report/get_not_built?startDate=${mdy(d1)}&endDate=${mdy(d2)}`);
        const l = (j.boxSummary || []).filter((r) => fits(customer, r.consigneeName)).map((r) => ({ consignee: r.consigneeName, city: `${String(r.consigneeCity || '').trim()}, ${r.consigneeState || ''}`, boxes: r.boxQty, cubes: r.boxCubes, pallets: r.palletQty, unscanned: r.unScannedBoxes, shipDate: r.shipDate, warehouse: (r.warehouseInfo || {}).warehouseName, shippers: (r.details || []).map((x) => `${x.shipperName} (${x.boxQty})`).slice(0, 8) }));
        return { from: d1, to: d2, note: 'Boxes received but not built onto a pallet / truck yet.', ...cut(l) };
      }
      case 'mismatched_arrived': {
        const legs = pageVar(await artisWeb.fetchText('/reports/mismatchedArrived'), 'tripLegs') || [];
        const l = legs.map((x) => { const s = x.legSum || {}; const ss = x.stopStatus || {}; return { trip: String(s.ls_trip_number || ''), truck: s.ls_power_unit || null, trailer: s.ls_trailer1 || null, bill: s.ls_freight || null, from: s.lego_zone_desc || null, to: s.legd_zone_desc || null, legStatus: s.ls_leg_stat || null, eta: ss.etaString || null, pinged: ss.pingDate || null }; });
        return { note: 'Legs where ARTIS\'s arrival and TruckMate\'s status disagree.', ...cut(l) };
      }
      case 'delivery_performance': {
        const j = await artisWeb.fetchJson(`/artis_ms/delivery_performance/summary?startDate=${d1}&endDate=${d2}`);
        const groups = Object.entries(j.groupings || {}).flatMap(([by, l]) => (l || []).filter((g) => customer && fits(customer, g.name)).map((g) => ({ by, name: g.name, ...g.stats })));
        return { from: d1, to: d2, overall: j.kpis || null, byWeekday: (j.weekdayMatrix || []).map((w) => ({ day: w.weekdayName, ...w.stats })), ...(customer ? { matches: groups.slice(0, 10) } : {}), note: 'Boxes received in the warehouse in this window and how they were delivered (delivery days, on time where a target is set).' };
      }
      case 'trip_documents': {
        const legs = pageVar(await artisWeb.fetchText(`/shipment/tripDetails?tripId=${encodeURIComponent(String(trip || '').replace(/\D/g, ''))}`), 'tripLegs') || [];
        const docs = legs.flatMap((l) => (l.documents || []).map((d) => ({ bill: l.bill_number, ...d })));
        return { trip: String(trip || ''), bills: legs.length, documents: docs.slice(0, 20), note: docs.length ? 'Synergize documents (BOL / POD) on the trip.' : 'No Synergize documents (BOL / POD) on this trip in ARTIS.' };
      }
      default: return { error: `Unknown ARTIS report "${which}".` };
    }
  }

  if (enabled()) {
    let last = 0;
    const t = setInterval(() => { if (now() - last < 29 * MIN) return; last = now(); refresh().then((r) => console.log(`[artis-reports] ${r.tractors} tractors, ${r.trailers} trailers, ${r.approaching} approaching, ${r.doorIssues} door-temp issues${r.errors.length ? `, errors: ${r.errors.join('; ')}` : ''}`)).catch((e) => console.warn('[artis-reports]', e.message)); }, 5 * MIN);
    if (t.unref) t.unref();
  }
  return { refresh, overlay, report };
}
