// ---------------------------------------------------------------
// A customer reports missing boxes (by phone with Jarvis, or by text) → a case is opened.
// Jarvis only GATHERS what the customer says — it never tells them how many boxes we received, scanned or
// loaded, or whether a box was received. The office (Customer Service, Sebastian Manotas, Sara Trujillo —
// editable: Employees → Alert emails) gets an email with what the customer said AND what the system shows
// (trip, delivery, ARTIS received / not received, trip sheet / Truck Builder counts, splits). The customer is
// told a case is open and the office will get back to them.
// ---------------------------------------------------------------
import { customerStops, nameScore } from './voice.js';

const SITE = 'florida-beauty';
const KEY = `taMissingBoxCases:${SITE}`;
const last10 = (p) => String(p || '').replace(/\D+/g, '').slice(-10);
const tripNo = (it) => String(((it && it.trip) || it || {}).tripNumber || '');
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const prettyPhone = (p) => { const d = last10(p); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : String(p || ''); };

// A text that is about missing / short boxes (English or Spanish). Pure.
export const MISSING_TEXT = /\b(missing|short|faltan?|faltaron|faltante|no (llegaron|recib\w*)|didn'?t (get|receive)|did not (get|receive)|never (got|received)|not (received|delivered))\b[^.]{0,60}\b(box|boxes|caja|cajas|bxs|pieces|piezas)\b|\b(box|boxes|caja|cajas|bxs)\b[^.]{0,40}\b(missing|short|faltan?|faltaron|faltante)\b/i;
export const isMissingBoxesText = (t) => MISSING_TEXT.test(String(t || ''));

// Case number like MB-1013-482. Pure.
export function caseId(now = Date.now(), rnd = Math.random) {
  const d = new Date(now).toLocaleDateString('en-US', { timeZone: 'America/New_York', month: '2-digit', day: '2-digit' }).replace('/', '');
  return `MB-${d}-${String(Math.floor(rnd() * 900) + 100)}`;
}

// What the system shows for the customer (internal — never told to the customer). Pure.
export function systemView(items, { business, trip } = {}) {
  if (!business && !trip) return [];
  let pool = items || [];
  if (trip) pool = pool.filter((it) => tripNo(it) === String(trip).replace(/\D/g, ''));
  const stops = business ? customerStops(pool, business, {}, { staff: true }) : [];
  if (!stops.length && trip && pool.length) {
    // a trip was given but no name match — list that trip's ARTIS customers close to what they said
    const it = pool[0];
    return ((it._artis && it._artis.stops) || []).filter((c) => !business || nameScore(business, c.consignee || '') >= 0.5)
      .map((c) => ({ trip: tripNo(it), customer: c.consignee, artis: `${c.scanned} of ${c.boxes} received${c.missing ? ` — ${c.missing} not received` : ''}` }));
  }
  return stops.map((x) => {
    const it = pool.find((i) => tripNo(i) === x.trip);
    const a = it && it._artis && (it._artis.stops || []).find((c) => nameScore(x.customer || '', c.consignee || '') >= 0.75 || nameScore(c.consignee || '', x.customer || '') >= 0.75);
    return {
      trip: x.trip, truck: x.truck, customer: x.customer, city: x.city,
      delivered: x.delivered ? (x.delivered_at || 'yes') : 'not yet',
      boxes_loaded: x.boxes_loaded || x.boxes || null,
      trip_sheet: x.boxes_on_trip_sheet || null,
      artis: a ? `${a.scanned} of ${a.boxes} received${a.missing ? ` — ${a.missing} not received from the shipper` : ''}${(a.shipDates || []).length > 1 ? ` (ship dates ${a.shipDates.join(', ')})` : ''}` : null,
      not_received_by_shipper: a && (a.shippers || []).length ? a.shippers.map((s) => `${s.shipper} ${s.missing}`).join(', ') : null,
      split: x.split_between_trailers || (a && a.split) || null,
    };
  });
}

// The office email: what the customer said + what the system shows. Pure.
export function caseEmail(c) {
  const row = (k, v) => (v ? `<tr><td><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>` : '');
  const said = [row('Business', c.business), row('Contact', c.contactName), row('Callback number', c.callbackNumber ? prettyPhone(c.callbackNumber) : null), row('Called / texted from', c.from ? prettyPhone(c.from) : null),
    row('Trip / invoice / PO they gave', c.trip || c.reference), row('Delivery date', c.deliveryDate), row('Delivery city', c.city), row('Boxes they say are missing', c.boxesMissing), row('What they said', c.details)].join('');
  const sys = c.system && c.system.length
    ? `<table border="1" cellpadding="6" cellspacing="0"><tr><th>Trip</th><th>Customer / stop</th><th>Delivered</th><th>Boxes loaded</th><th>ARTIS (received at our terminal)</th><th>Not received, by shipper</th><th>Notes</th></tr>${c.system.map((s) => `<tr><td>${esc(s.trip)}${s.truck ? ` · truck ${esc(s.truck)}` : ''}</td><td>${esc(s.customer)}${s.city ? ` (${esc(s.city)})` : ''}</td><td>${esc(s.delivered || '')}</td><td>${esc(s.boxes_loaded || '')}${s.trip_sheet ? ` (trip sheet ${esc(s.trip_sheet)})` : ''}</td><td>${esc(s.artis || '—')}</td><td>${esc(s.not_received_by_shipper || '')}</td><td>${esc(s.split || '')}</td></tr>`).join('')}</table>`
    : '<p>The system could not match this to a load on the board yet (no business name / trip, or it is no longer on the board) — please look it up.</p>';
  return {
    subject: `Missing boxes case ${c.id} — ${c.business || prettyPhone(c.callbackNumber || c.from) || 'customer'}${c.system && c.system[0] ? ` (trip ${c.system[0].trip})` : ''}`,
    html: `<p>A customer reported missing boxes ${c.channel === 'text' ? 'by text' : 'on a call with Jarvis'}. Case <b>${esc(c.id)}</b>.</p>
<p><b>What the customer said</b></p><table border="1" cellpadding="6" cellspacing="0">${said}</table>
<p><b>What the system shows</b> (internal — the customer was NOT told any counts or whether boxes were received)</p>${sys}
<p>The customer was told: "A case has been opened for your missing boxes and the office will get back to you." Please contact them${c.callbackNumber || c.from ? ` at ${esc(prettyPhone(c.callbackNumber || c.from))}` : ''}.</p>`,
  };
}

// The text sent back to a customer who texted about missing boxes. Pure.
export const caseTextReply = (id, firstTime = true) => (firstTime
  ? `Florida Beauty Flora: we opened case ${id} for your missing boxes. Our office will review it and get back to you. If you haven't yet, reply with your business name, trip / invoice / PO number, delivery date and how many boxes are missing.`
  : `Florida Beauty Flora: thank you — we added that to case ${id}. Our office will get back to you.`);

// Group cases by customer (how many times each one filed). Pure.
export function byCustomer(cases) {
  const key = (c) => String(c.business || (c.system && c.system[0] && c.system[0].customer) || c.callbackNumber || c.from || 'Unknown').toUpperCase().replace(/[^A-Z0-9& ]+/g, ' ').replace(/\b(LLC|INC|CORP|CO)\b/g, ' ').replace(/\s+/g, ' ').trim();
  const groups = new Map();
  for (const c of cases || []) {
    const k = key(c);
    const g = groups.get(k) || { customer: c.business || (c.system && c.system[0] && c.system[0].customer) || k, cases: 0, open: 0, boxesReported: 0, first: c.at, last: c.at, ids: [] };
    g.cases += 1; if ((c.status || 'open') !== 'resolved') g.open += 1;
    const n = parseInt(String(c.boxesMissing || '').replace(/\D+/g, ''), 10); if (n) g.boxesReported += n;
    if (c.at < g.first) g.first = c.at; if (c.at > g.last) g.last = c.at;
    g.ids.push(c.id); groups.set(k, g);
  }
  return [...groups.values()].sort((a, b) => b.cases - a.cases || String(b.last).localeCompare(String(a.last)));
}
export const STATUSES = ['open', 'in progress', 'resolved'];

export function initMissingCases({ app = null, requireAuth = null, db, sendMail = null, recipients = null, getBoard = null, now = () => Date.now() }) {
  const board = async () => (getBoard ? (await getBoard(SITE).catch(() => [])) || [] : []);
  async function email(c, update = null) {
    if (!sendMail) return;
    const to = recipients ? await recipients() : [];
    if (!to.length) { console.warn('[missing-boxes] nobody on the list (Employees → Alert emails)'); return; }
    const m = caseEmail(c);
    await sendMail({ to, subject: update ? `Re: ${m.subject}` : m.subject, html: update ? `<p><b>The customer added:</b> ${esc(update)}</p>${m.html}` : m.html });
  }
  async function save(c) {
    if (!(db && db.enabled)) return;
    await db.update(KEY, (cur) => [c, ...(Array.isArray(cur) ? cur : []).filter((x) => x.id !== c.id)].slice(0, 500), []);
  }
  // a call: Jarvis gathered the details
  async function open(said) {
    const c = { id: caseId(now()), status: 'open', at: new Date(now()).toISOString(), channel: said.channel || 'call', from: said.from || null, callId: said.callId || null,
      business: said.business || null, contactName: said.contactName || null, callbackNumber: said.callbackNumber || null, trip: said.trip || null, reference: said.reference || null,
      deliveryDate: said.deliveryDate || null, city: said.city || null, boxesMissing: said.boxesMissing || null, details: said.details || null, updates: [] };
    c.system = systemView(await board(), { business: c.business, trip: c.trip });
    await save(c);
    await email(c).catch((e) => console.warn('[missing-boxes] email:', e.message));
    return c;
  }
  // a text: open a case, or add to this phone's open text case (48 h)
  async function fromText({ from, text }) {
    const list = (db && db.enabled) ? ((await db.get(KEY, [])) || []) : [];
    const open48 = list.find((c) => c.channel === 'text' && last10(c.from) === last10(from) && Date.parse(c.at) > now() - 48 * 3600000);
    if (open48) {
      const c = { ...open48, updates: [...(open48.updates || []), { at: new Date(now()).toISOString(), text: String(text).slice(0, 600) }] };
      const trip = (String(text).match(/\b6\d{5}\b/) || [])[0];
      if (trip && !c.trip) c.trip = trip;
      c.system = systemView(await board(), { business: c.business || String(text).slice(0, 80), trip: c.trip });
      await save(c);
      await email(c, String(text).slice(0, 600)).catch(() => {});
      return { id: c.id, reply: caseTextReply(c.id, false) };
    }
    if (!isMissingBoxesText(text)) return null;
    const trip = (String(text).match(/\b6\d{5}\b/) || [])[0] || null;
    const c = await open({ channel: 'text', from, callbackNumber: from, trip, details: String(text).slice(0, 600) });
    return { id: c.id, reply: caseTextReply(c.id, true) };
  }
  // the console's Missing boxes tab: every case, and the office's status / notes
  if (app && requireAuth) {
    const who = (req) => (req.user && (req.user.name || req.user.email)) || 'dispatcher';
    app.get('/truckmate/missing-cases', requireAuth, async (req, res) => {
      try { const list = (await db.get(KEY, [])) || []; res.json({ cases: list.map((c) => ({ status: 'open', ...c })), byCustomer: byCustomer(list) }); } catch (e) { res.status(500).json({ error: e.message }); }
    });
    app.post('/truckmate/missing-cases/:id', requireAuth, async (req, res) => {
      try {
        const b = req.body || {};
        const status = STATUSES.includes(b.status) ? b.status : null;
        const note = String(b.note || '').trim().slice(0, 600);
        let found = null;
        await db.update(KEY, (cur) => (Array.isArray(cur) ? cur : []).map((c) => {
          if (c.id !== req.params.id) return c;
          found = { ...c, ...(status ? { status } : {}), notes: [...(c.notes || []), ...(note || status ? [{ at: new Date(now()).toISOString(), by: who(req), note: note || null, status: status || null }] : [])] };
          return found;
        }), []);
        if (!found) return res.status(404).json({ error: 'Case not found' });
        res.json(found);
      } catch (e) { res.status(500).json({ error: e.message }); }
    });
  }
  return { open, fromText };
}
