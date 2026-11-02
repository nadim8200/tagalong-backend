// How many deliveries a load has left, and which. Same reading as the card: the trip sheet's delivery stops when there is one, otherwise
// the bills by customer and city. A stop counts as done once every bill in its city is delivered in TruckMate. Pure.
const billsOf = (item) => (item && (item.freightBills || item.orders)) || (item && item.trip && item.trip.freightBills) || [];
const town = (x) => String(x || '').split(',')[0].trim().toUpperCase();
const clean = (x) => String(x || '').replace(/\s*\*$/, '').replace(/\s*>+\s*$/, '').trim() || null;

export function stopsLeft(item) {
  const bills = billsOf(item);
  const inCity = (c) => bills.filter((b) => town(b.endZoneDescription || b.endZone) === town(c));
  const doneIn = (c) => { const bs = inCity(c); return bs.length > 0 && bs.every((b) => b.actualDelivery); };
  const sheet = ((item && item._manifest && item._manifest.stops) || []).filter((s) => /DELIVER/i.test(s.action || ''));
  const stops = sheet.length
    ? sheet.map((s) => ({ customer: clean(s.customer), place: [s.city, s.state].filter(Boolean).join(', ') || s.tmPlace || null, delivered: doneIn(s.tmPlace || s.city) }))
    : [...new Map(bills.map((b) => [`${b.billToName}|${b.endZoneDescription || b.endZone}`, b])).values()].map((b) => ({ customer: clean(b.billToName), place: b.endZoneDescription || b.endZone || null, delivered: bills.filter((x) => x.billToName === b.billToName && (x.endZoneDescription || x.endZone) === (b.endZoneDescription || b.endZone)).every((x) => x.actualDelivery) }));
  const left = stops.filter((s) => !s.delivered);
  return { count: left.length, total: stops.length, stops: left.map(({ customer, place }) => ({ customer, place })) };
}
