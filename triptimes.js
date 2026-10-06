// ---------------------------------------------------------------
// When a trip was created (in TruckMate), added (to AI Dispatcher's board)
// and dispatched. Pure.
//   created    — a trip-level created date if TruckMate sends one, else the
//                earliest freight bill createdTime (+ createdBy)
//   added      — first time the trip reached the board
//   dispatched — first status change to a dispatched (or later) status; if the
//                trip was already past dispatch when first seen, only "before"
// ---------------------------------------------------------------

const PRE_DISPATCH = /^(avail|avbl|new|plan|assgn|assigned|printed|pend|quote|open)/i;
const DONE = /^(canc|void)/i;
// TruckMate sends wall-clock times with no zone — Florida Beauty's office
// (America/New_York). Times that carry a zone are used as-is.
function nyToUtcMs(local) {
  const m = String(local).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return NaN;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asNy = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return guess + (guess - asNy);
}
const isoOf = (v) => {
  if (v == null || v === '') return null;
  const str = String(v);
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(str);
  const t = hasZone ? Date.parse(str) : nyToUtcMs(str);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

function tripField(inner, re) {
  for (const [k, v] of Object.entries(inner || {})) {
    if (!re.test(k) || typeof v === 'object') continue;
    const iso = isoOf(v);
    if (iso) return { key: k, at: iso };
  }
  return null;
}

export function tripTimes(rec) {
  const item = (rec && rec.item) || {};
  const inner = item.trip || item;
  const bills = (item.freightBills || item.orders || inner.freightBills || []);
  // created
  let created = tripField(inner, /^(created(time|date|on|at)?|createdate|entered(date|time)?|tripcreated)$/i);
  let createdBy = inner.createdBy || null;
  if (!created) {
    const withTime = (Array.isArray(bills) ? bills : []).map((b) => ({ at: isoOf(b.createdTime || b.createdDate), by: b.createdBy || null })).filter((x) => x.at).sort((a, b) => a.at.localeCompare(b.at));
    if (withTime.length) { created = { key: 'first bill', at: withTime[0].at }; createdBy = createdBy || withTime[0].by; }
  }
  // dispatched: a trip-level dispatch date if sent, else the status history
  let dispatchedAt = null; let dispatchedBefore = null; let dispatchedFrom = null;
  const direct = tripField(inner, /dispatch/i);
  if (direct) { dispatchedAt = direct.at; dispatchedFrom = 'TruckMate'; }
  else {
    const hist = Array.isArray(rec.statusHistory) ? rec.statusHistory : [];
    const hit = hist.find((h) => !PRE_DISPATCH.test(h.status) && !DONE.test(h.status));
    if (hit && hit.first) dispatchedBefore = new Date(hit.at).toISOString();      // already past dispatch when first seen
    else if (hit) { dispatchedAt = new Date(hit.at).toISOString(); dispatchedFrom = 'status change'; }
    else if (!hist.length) {
      // no history recorded yet (no TruckMate update since tracking began):
      // go by the current status — dispatched at some point before the last update
      const st = String(inner.status || '');
      if (st && !PRE_DISPATCH.test(st) && !DONE.test(st) && rec.updatedAt) dispatchedBefore = new Date(rec.updatedAt).toISOString();
    }
  }
  // a load with no truck on it hasn't really been dispatched, whatever the status says
  const noTruck = !String(inner.powerUnit || '').trim();
  if (noTruck && dispatchedFrom !== 'TruckMate') { dispatchedAt = null; dispatchedBefore = null; dispatchedFrom = null; }
  return {
    noTruck,
    createdAt: created ? created.at : null, createdBy, createdFrom: created ? (created.key === 'first bill' ? 'first freight bill' : 'TruckMate') : null,
    // not seen since tracking began → it was on the board before its last update
    addedAt: rec && (rec.firstSeenAt || rec.updatedAt) ? new Date(rec.firstSeenAt || rec.updatedAt).toISOString() : null,
    addedBefore: !!(rec && (rec.addedBefore || (!rec.firstSeenAt && rec.updatedAt))),
    dispatchedAt, dispatchedBefore, dispatchedFrom,
    statusHistory: ((rec && rec.statusHistory) || []).map((h) => ({ status: h.status, desc: h.desc, at: new Date(h.at).toISOString() })),
  };
}
