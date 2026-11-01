// ---------------------------------------------------------------
// The physical handoff record. A truck change in TruckMate, two trucks parked together, or a truck driving off proves nothing:
// a transfer only counts when a driver answers YES to Jarvis's question or staff say so by email. Each handoff is one saved record
// (before snapshot, who confirmed, when), and "Transfer completed" goes out once from that record, across retries and restarts.
// Records only start when this code is live, so nothing old is ever sent.
// ---------------------------------------------------------------
import { transferPlan } from './transferwatch.js';
import { snapshotLoad, crewOf, handoffFacts, renderTransferCompletedEmail } from './handoffmail.js';

const KEY = (site) => `taTransferDone:${site}`;
const DAY = 86400000;
const KEEP_OPEN_DAYS = 14;
const MAX_TRIES = 5;
const unitKey = (x) => String(x || '').replace(/[^0-9A-Z]/gi, '').replace(/^0+/, '').toUpperCase();
const tripOf = (it) => (it && it.trip) || {};
const oneLine = (s, n) => (s ? String(s).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n) : null);

// Is this answer a clear "the handoff happened"? "Ya voy" and "almost done" are not. Pure.
export function confirmsHandoff(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return false;
  if (/\b(no|not|n't|almost|soon|about to|on my way|going|later|casi|voy|vamos|ahorita|falta|waiting|espera|didn'?t|voicemail|unable|never|nunca)\b/.test(t)) return false;
  return /^(yes|yeah|yep|y(?![a-z])|s[ií](?![a-z])|done|listo|hecho|ya (est[aá]|qued[oó]|lo hice|lo hicimos|termin)|transfer(red)?\b|completed?|finished|hooked|we switched|switched)/.test(t);
}
// A driver's answer counts only as a text reply, or a call summary that clearly says so (never the raw transcript, which has Jarvis's own question in it). Pure.
export const answerConfirms = (ans) => !!ans && ans.status === 'done' && (ans.source === 'driver text' ? confirmsHandoff(String(ans.summary || '').replace(/^Driver replied:\s*"?/, '').replace(/"$/, '')) : ans.source === 'phone call' ? confirmsHandoff(ans.summary) : false);

// Where the load is now: same trip, else the receiving truck's trip that carries one of the same bills. Pure.
export function findAfter(rec, board) {
  const trips = (board && board.trips) || [];
  const same = trips.find((it) => String(tripOf(it).tripNumber) === String(rec.trip));
  if (same) return same;
  const bills = new Set((rec.before && rec.before.bills) || []);
  return trips.find((it) => unitKey(tripOf(it).powerUnit) === unitKey(rec.to) && (it.freightBills || it.orders || []).some((b) => bills.has(String(b.billNumber)))) || null;
}

export function initTransferDone({ db, sendMail, recipients, rescueRecipients, staffOnly = () => false, etas = async () => ({}), reportFor = async () => null, onDone = async () => {}, site = 'florida-beauty', now = () => Date.now() }) {
  const eventKey = (trip, from, to) => `${trip}|${unitKey(from)}|${unitKey(to)}`;
  const all = async () => (await db.get(KEY(site), {})) || {};
  const patch = (k, fields) => db.update(KEY(site), (cur) => ({ ...(cur || {}), [k]: { ...(cur || {})[k], ...fields } }), {});

  // each board refresh: keep the "before" of every planned transfer while it can still be seen
  async function observe(board) {
    const plans = ((board && board.trips) || []).map((it) => ({ it, plan: transferPlan(it) })).filter((x) => x.plan);
    const at = now();
    const eta = plans.length ? await etas().catch(() => ({})) : {};
    const reports = {};
    for (const { plan } of plans) reports[plan.trip] = await reportFor(plan.trip).catch(() => null); // eslint-disable-line no-await-in-loop
    await db.update(KEY(site), (cur) => {
      const c = {};
      for (const [k, r] of Object.entries(cur || {})) if (r.status !== 'open' || at - (r.planAt || 0) < KEEP_OPEN_DAYS * DAY) c[k] = r;
      for (const { it, plan } of plans) {
        const k = eventKey(plan.trip, plan.from, plan.to);
        const onFrom = unitKey(tripOf(it).powerUnit) === unitKey(plan.from);
        const rep = reports[plan.trip];
        const r = c[k] || { trip: plan.trip, from: plan.from, to: plan.to, rescue: !!plan.rescue, subject: (plan.rescue && plan.rescue.subject) || null, status: 'open', planAt: at, attempts: 0, crew: rep && rep.crew ? { [unitKey(plan.from)]: rep.crew } : {}, before: (onFrom ? snapshotLoad(it, eta[plan.trip], at) : (rep && rep.before)) || null };
        const crew = { ...r.crew };
        if (onFrom) crew[unitKey(plan.from)] = crewOf(it, at);
        const receiving = ((board && board.trips) || []).find((x) => unitKey(tripOf(x).powerUnit) === unitKey(plan.to));
        if (receiving) crew[unitKey(plan.to)] = crewOf(receiving, at);
        c[k] = { ...r, crew, recordedAt: r.recordedAt || (!onFrom && unitKey(tripOf(it).powerUnit) === unitKey(plan.to) ? at : null) };
      }
      return c;
    }, {});
  }

  const openFor = (c, { trip, truck }) => Object.entries(c).filter(([, r]) => (trip ? String(r.trip) === String(trip) : [unitKey(r.from), unitKey(r.to)].includes(unitKey(truck))) && r.status !== 'cancelled' && r.status !== 'reversed').sort((x, y) => y[1].planAt - x[1].planAt)[0] || null;

  // An explicit confirmation: the only way a record reaches "confirmed". Sending happens in process().
  async function confirm({ trip = null, truck = null, toTruck = null, by, source, atMs = null, atText = null, location = null, type = null, scope = null, arrivalFrom = null, arrivalTo = null, summary = null, board = null }) {
    let hit = openFor(await all(), { trip, truck });
    if (hit && toTruck && unitKey(hit[1].to) !== unitKey(toTruck)) return { ok: false, error: `Jarvis has trip ${hit[1].trip} going to truck ${hit[1].to}, not ${toTruck}. Reply with the right truck.` };
    if (!hit) {
      // nothing was planned on record: staff can still confirm it, with the load and both trucks named
      const it = trip && ((board && board.trips) || []).find((x) => String(tripOf(x).tripNumber) === String(trip));
      const from = truck || (it && tripOf(it).powerUnit);
      if (!it || !from || !/\d/.test(String(toTruck || '')) || unitKey(from) === unitKey(toTruck)) return { ok: false, error: 'Which load, and which trucks? Reply with the trip and both truck numbers.' };
      const k = eventKey(trip, from, toTruck);
      const r = { trip: String(trip), from: String(from), to: String(toTruck), rescue: false, subject: null, status: 'open', planAt: now(), attempts: 0, crew: {}, before: unitKey(tripOf(it).powerUnit) === unitKey(from) ? snapshotLoad(it, null, now()) : null };
      await patch(k, r);
      hit = [k, r];
    }
    const [k, r] = hit;
    if (r.status !== 'open') return { ok: true, already: true, trip: r.trip };
    await patch(k, { status: 'confirmed', confirm: { reportedAt: now(), by: oneLine(by, 80) || 'Dispatch', source, atMs: atMs || null, atText: oneLine(atText, 60), location: oneLine(location, 200), type: oneLine(type, 40), scope: oneLine(scope, 20), arrivalFrom: oneLine(arrivalFrom, 60), arrivalTo: oneLine(arrivalTo, 60), summary: oneLine(summary, 220) } });
    return { ok: true, trip: r.trip };
  }

  // Staff say the transfer is off or was undone. Unsent stays unsent; if the email already went, the same people hear it.
  async function cancel({ trip = null, truck = null, by }) {
    const hit = openFor(await all(), { trip, truck });
    if (!hit) return { ok: false, error: 'No transfer on file for that load.' };
    const [k, r] = hit;
    const wasSent = r.status === 'sent';
    await patch(k, { status: wasSent ? 'reversed' : 'cancelled', cancelledBy: oneLine(by, 80), cancelledAt: now() });
    if (wasSent) {
      const to = await (r.rescue ? rescueRecipients() : recipients());
      const head = `Transfer reversed — Trip ${r.trip}: truck ${r.from} → ${r.to}`;
      if (to.length) await sendMail({ to, subject: r.subject ? `Re: ${r.subject}` : head, text: `${head}\nReported by ${oneLine(by, 80) || 'Dispatch'}. Disregard the earlier "Transfer completed" email.`, html: `<p style="font-family:Arial,Helvetica,sans-serif;font-size:16px;"><b>${String(head).replace(/[&<>"]/g, '')}</b><br>Reported by ${String(oneLine(by, 80) || 'Dispatch').replace(/[&<>"]/g, '')}. Disregard the earlier "Transfer completed" email.</p>` }, { rescue: r.rescue && staffOnly(to) });
    }
    return { ok: true, trip: r.trip };
  }

  // Each confirmed handoff, once. Claimed before sending so a restart can't send it twice; a failed send goes back in line.
  async function process(board) {
    const pending = Object.entries(await all()).filter(([, r]) => r.status === 'confirmed' && (r.attempts || 0) < MAX_TRIES);
    const out = [];
    for (const [k, r] of pending) {
      const item = findAfter(r, board);
      // TruckMate had it on the receiving truck and put it back: the handoff is undone, no success email
      if (r.recordedAt && item && unitKey(tripOf(item).powerUnit) === unitKey(r.from)) { await patch(k, { status: 'reversed', cancelledBy: 'TruckMate', cancelledAt: now() }); continue; } // eslint-disable-line no-await-in-loop
      let claimed = false;
      await db.update(KEY(site), (cur) => { const x = (cur || {})[k]; if (!x || x.status !== 'confirmed') return cur; claimed = true; return { ...cur, [k]: { ...x, status: 'sending', sendingAt: now() } }; }, {}); // eslint-disable-line no-await-in-loop
      if (!claimed) continue;
      try {
        const to = await (r.rescue ? rescueRecipients() : recipients()); // eslint-disable-line no-await-in-loop
        if (!to.length) throw new Error('no recipients');
        const eta = await etas().catch(() => ({})); // eslint-disable-line no-await-in-loop
        const m = renderTransferCompletedEmail(handoffFacts(r, item, { etas: item ? eta[tripOf(item).tripNumber] : null, now: now(), showPhones: to.every((e) => /@floridabeauty\.us$/i.test(e)) }));
        await sendMail({ to, ...m, ...(r.subject ? { subject: `Re: ${r.subject}` } : {}) }, { rescue: r.rescue && staffOnly(to) }); // eslint-disable-line no-await-in-loop
        await patch(k, { status: 'sent', sentAt: now() }); // eslint-disable-line no-await-in-loop
        await onDone(r).catch(() => {}); // eslint-disable-line no-await-in-loop
        out.push(r.trip);
      } catch (e) {
        console.warn('[transfer-done]', r.trip, e.message);
        await patch(k, { status: 'confirmed', attempts: (r.attempts || 0) + 1 }); // eslint-disable-line no-await-in-loop
      }
    }
    return out;
  }

  // the transfer watch stops asking once someone has confirmed
  const isConfirmed = async (plan) => { const r = (await all())[eventKey(plan.trip, plan.from, plan.to)]; return !!r && ['confirmed', 'sending', 'sent'].includes(r.status); };
  return { observe, confirm, cancel, process, isConfirmed };
}
