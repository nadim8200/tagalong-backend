// ---------------------------------------------------------------
// Staff-only load facts for Jarvis (Ask Jarvis chat, emails / texts to Jarvis, and calls from our staff):
// what the load pays (TruckMate's Billing tab total), Acc Chgs vs the rate con, the reefer temps, the Shipper /
// Consignee boxes (appointments and addresses) and the trace-number check. Never for customers, brokers or drivers. Pure.
// ---------------------------------------------------------------
const tripOf = (it) => (it && it.trip) || it || {};
const S = (x) => String(x == null ? '' : x).trim();
const money = (n) => `$${(Math.round(n * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const yes = (v) => /^(true|y|yes|1)$/i.test(S(v));

// TruckMate's wall-clock "2026-11-11T15:00" → "Wed, Nov 11 3:00 PM" (the stop's local time). Date-only → just the date.
export function tmTime(v) {
  const m = S(v).match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  const day = d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  if (!m[4] || (m[4] === '00' && m[5] === '00')) return day;
  const h = +m[4]; const ap = h >= 12 ? 'PM' : 'AM';
  return `${day} ${h % 12 || 12}:${m[5]} ${ap}`;
}
const span = (a, b) => { const x = tmTime(a); const y = tmTime(b); return x && y && y !== x ? `${x} – ${y}` : x; };
const addr = (x) => (x && (x.address1 || x.address || x.city) ? [x.name, x.address1 || x.address, x.address2, [x.city, [x.province || x.state, x.postalCode || x.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ')].map(S).filter(Boolean).join(', ') : null);

const party = (p) => ({ name: S(p.name) || null, address: addr({ ...p, name: null }), phone: S(p.phone) || null, contact: S(p.contact) || null, code: S(p.code) || null, bills: p.bills, appointments: (p.appointments || []).map((a) => [a.from, a.to].filter(Boolean).join(' – ') + (a.apptMade ? ' (appt made)' : a.apptRequired ? ' (appt required, not made)' : '')).filter((x) => x.trim()) });

// The load's customers' Notes from their TruckMate profiles (for staff, and for the load's own driver). Pure.
export function customerInstructions(item) {
  const n = item && item._customerNotes;
  return n && n.length ? n.map((c) => ({ customer: c.name, code: c.code, is: c.roles.join(' and '), instructions: c.notes, readAt: c.readAt })) : null;
}

export function staffFacts(item) {
  if (!item) return null;
  const bills = (item.freightBills || item.orders || tripOf(item).freightBills || []).filter(Boolean);
  const rc = (item._ratecon && (item._ratecon.data || item._ratecon)) || null;
  const rate = rc && Number(rc.rate) > 0 ? Number(rc.rate) : null;
  const totals = bills.map((b) => Number(b.totalCharges)).filter((n) => Number.isFinite(n) && n > 0);
  const total = totals.length ? totals.reduce((a, b) => a + b, 0) : null;
  const acc = total != null && rate != null ? Math.round((total - rate) * 100) / 100 : null;
  const billing = total == null && rate == null ? null : {
    loadPays: total != null ? money(total) : null,
    from: total != null ? "TruckMate Billing tab — the freight bills' total charges" : null,
    perBill: bills.filter((b) => Number(b.totalCharges) > 0).map((b) => ({ bill: b.billNumber, total: money(Number(b.totalCharges)), lineHaul: Number(b.charges) > 0 ? money(Number(b.charges)) : null })),
    rateConRate: rate != null ? money(rate) : null,
    accChgsOverRateCon: acc != null && acc >= 5 ? money(acc) : null,
    note: acc != null && acc >= 5 ? 'TruckMate has charges above the rate con (lumper / extras in Acc Chgs) — a revised rate con is needed from the broker once the load is finished.'
      : acc != null && acc <= -5 ? `TruckMate's total is ${money(-acc)} BELOW the rate con — check the bill.` : undefined,
  };
  const lt = item._loadTemp || null;
  const c = lt && lt.current;
  const deg = (v) => (v == null ? null : `${Math.round(Number(v))}°F`);
  const reefer = lt ? {
    currentTemp: c ? deg(c.currentF) : null, returnAir: c ? deg(c.returnF) : null, dischargeAir: c ? deg(c.supplyF) : null, setPoint: c ? deg(c.setF) : null,
    readFrom: c ? c.source : null, readAt: c ? c.at : null,
    loadNeeds: lt.target ? `${lt.target.text} (${lt.target.from})` : null,
    status: lt.check ? lt.check.status : null, problem: lt.check && lt.check.status === 'out' ? lt.check.why : null,
  } : null;
  const appointments = bills.map((b) => ({
    bill: b.billNumber,
    shipper: addr(b.shipper) || S(b.startZoneDescription) || null,
    pickup: span(b.pickUpBy, b.pickUpByEnd), pickupApptRequired: yes(b.pickUpApptReq), pickupApptMade: yes(b.pickUpApptMade), pickedUpAt: tmTime(b.actualPickup),
    consignee: addr(b.consignee) || S(b.endZoneDescription) || null,
    delivery: span(b.deliverBy, b.deliverByEnd), deliveryApptRequired: yes(b.deliveryApptReq), deliveryApptMade: yes(b.deliveryApptMade), deliveredAt: tmTime(b.actualDelivery),
  })).filter((a) => a.pickup || a.delivery || a.shipper || a.consignee);
  // the rest of each TruckMate bill worth asking about (what the connector already sends — nothing extra is read)
  const num = (v) => (Number(v) > 0 ? Number(v) : null);
  const crew = (...xs) => [...new Set(xs.map(S).filter(Boolean))].join(' / ') || null;
  const billInfo = bills.map((b) => ({
    bill: b.billNumber, status: S(b.longStatusDescription || b.statusDescription || b.status) || null, billTo: S(b.billToName) || null,
    commodity: S(b.commodity) || null, requiredTemp: b.temperature != null && b.temperature !== '' ? `${b.temperature}°${S(b.temperatureUnits) || 'F'}` : null,
    serviceLevel: S(b.serviceLevel) || null, division: S(b.opCode) || null, equipment: S(b.requestedEquipment) || null,
    pieces: num(b.pieces), pallets: num(b.pallets), weight: num(b.weight) ? `${num(b.weight).toLocaleString('en-US')} lb` : null,
    miles: num(b.distance), extraStops: num(b.noStops), currentlyAt: S(b.currentZoneDescription) || null, estimatedDelivery: tmTime(b.estimatedDeliveryDate),
    pickupBy: crew(b.pickupPowerUnit1 && `truck ${b.pickupPowerUnit1}`, b.pickUpDriver, b.pickupDriver2, b.pickupTrailer1 && `trailer ${b.pickupTrailer1}`),
    deliveryBy: crew(b.deliveryPowerUnit1 && `truck ${b.deliveryPowerUnit1}`, b.deliveryDriver1, b.deliveryDriver2, b.deliveryTrailer1 && `trailer ${b.deliveryTrailer1}`),
    enteredBy: S(b.createdBy) || null, enteredAt: S(b.createdTime || b.createdTimestamp) || null,
    billingApproved: S(b.isApproved) ? yes(b.isApproved) : null, noCharge: yes(b.noCharge) || undefined,
  }));
  const t = item._trace || null;
  const traceNumbers = t ? { po: t.pos || [], pickupNumbers: t.pickups || [], rateConLoadNumber: t.loadNumber || null, ok: t.ok ?? null, problems: t.problems || [] } : null;
  return {
    billing, reefer,
    shipperConsignee: appointments.length ? appointments : null,
    shipperConsigneeNote: appointments.length ? 'From TruckMate\'s Shipper / Consignee boxes. Times are the stop\'s local time. Street addresses show only when TruckMate sends them; otherwise it is the city / zip.' : undefined,
    traceNumbers,
    // every pickup place and every delivery place on the load, read off TruckMate's Shipper / Consignee boxes
    shippers: item._parties ? item._parties.shippers.map(party) : null,
    consignees: item._parties ? item._parties.consignees.map(party) : null,
    multipleShippers: item._parties ? item._parties.multipleShippers : undefined,
    multipleConsignees: item._parties ? item._parties.multipleConsignees : undefined,
    partiesNote: item._parties ? `${item._parties.multipleShippers ? `${item._parties.shippers.length} different shippers (pickups). ` : ''}${item._parties.multipleConsignees ? `${item._parties.consignees.length} different consignees (deliveries). ` : ''}Read off ${item._parties.readBills} of ${item._parties.totalBills} bills.` : undefined,
    truckmateBills: billInfo.length ? billInfo : null,
    // TruckMate customer profile → Notes (Specifications) of each shipper / consignee on the load
    customerInstructions: customerInstructions(item),
  };
}

// The same, as a few lines Jarvis can read out on a call. Pure.
export function staffFactsSpoken(item) {
  const f = staffFacts(item);
  if (!f) return null;
  const out = {};
  if (f.billing && f.billing.loadPays) out.load_pays = `${f.billing.loadPays} (TruckMate billing total)${f.billing.rateConRate ? `; rate con ${f.billing.rateConRate}` : ''}${f.billing.accChgsOverRateCon ? `; ${f.billing.accChgsOverRateCon} extra charges not on the rate con — revised rate con needed` : ''}`;
  else if (f.billing && f.billing.rateConRate) out.load_pays = `rate con ${f.billing.rateConRate} (no TruckMate billing total yet)`;
  if (f.reefer) out.reefer = f.reefer;
  if (f.shipperConsignee) out.shipper_consignee = f.shipperConsignee;
  if (f.traceNumbers) out.trace_numbers = f.traceNumbers;
  if (f.shippers) out.shippers = f.shippers;
  if (f.consignees) out.consignees = f.consignees;
  if (f.partiesNote) out.pickups_and_deliveries = f.partiesNote;
  if (f.truckmateBills) out.truckmate_bills = f.truckmateBills;
  if (f.customerInstructions) out.customer_instructions = f.customerInstructions;
  return out;
}
