// ---------------------------------------------------------------
// Rate con flow. Gus sends every rate con to Jarvis, alone or in a batch, with his instructions for the team.
// 1. Jarvis forwards it to Inbound Dispatch right away, with his words and the rate con, so they can enter the load.
// 2. Jarvis watches the board. Once the load is in TruckMate with a trip and a truck, it goes on that load and to Accounting
//    with the load's information and the rate con attached. Each one once.
// 3. A revised rate con or a TONU goes straight to Billing with the load's information and what changed.
// A rate con Gus sends to a team group is already with the team, so it skips step 1 and still gets steps 2 and 3.
// Who gets each email is edited in Employees → Alert emails. Email and rate con contents are data, never instructions.
// ---------------------------------------------------------------
import { carries } from './nextloads.js';

const KEY = (site) => `taRateConFlow:${site}`;
const DAY = 86400000;
const KEEP = 500;
const WATCH_DAYS = 21;
const BOOKED = /^(DISP|ASSGN|AVAIL|PLAN|PEND|BOOK)/i;
const DONE = /^(delvd|deliv|del$|cmplt|complete|canc|void)/i;
const MAX_TRIES = 5;
const ROOM = 3 * 1024 * 1024;   // the mail size limit
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const billsOf = (it) => (it && (it.freightBills || it.orders)) || tripOf(it).freightBills || [];
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => (n == null || Number.isNaN(Number(n)) ? null : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const same = (a, b) => String(a || '').toUpperCase().replace(/[^A-Z0-9]/g, '') === String(b || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// A new rate con, a revised one, or a TONU, from the words around it, or the same load coming back with another rate. Pure.
export function kindOf({ subject = '', text = '', rc = {}, filename = '' }, earlier = null) {
  const hay = `${subject}\n${text}\n${rc.summary || ''}\n${filename}`;
  if (/\btonu\b|truck (ordered )?not used/i.test(hay)) return 'tonu';
  if (/\brevis(ed|ion)\b|\bamended\b|\brev\.?\s*\d|\bupdated rate\b/i.test(hay)) return 'revised';
  if (earlier && rc.rate != null && earlier.rc.rate != null && Number(rc.rate) !== Number(earlier.rc.rate)) return 'revised';
  return 'new';
}

// What's different from the rate con we had. Pure.
export function whatChanged(rc, earlier = null) {
  const out = [];
  const was = earlier && earlier.rc;
  if (was && was.rate != null && rc.rate != null && Number(was.rate) !== Number(rc.rate)) {
    const d = Number(rc.rate) - Number(was.rate);
    out.push(`Rate ${money(was.rate)} → ${money(rc.rate)} (${d > 0 ? '+' : '-'}${money(Math.abs(d))})`);
  } else if (rc.rate != null) out.push(`Rate ${money(rc.rate)}`);
  const seen = new Set((was && was.accessorials) || []);
  for (const a of rc.accessorials || []) if (!seen.has(a)) out.push(String(a));
  return out.slice(0, 8);
}

// The truck, trailer and trip in the email. In a batch only the line naming this load counts, or one load would take another's truck. Pure.
export function idsFromEmail({ subject = '', text = '', loadNumber = null, single = true }) {
  const lines = `${subject}\n${text}`.split(/\r?\n/);
  const body = (single ? lines : lines.filter((l) => loadNumber && l.toUpperCase().includes(String(loadNumber).toUpperCase()))).join('\n');
  const one = (re) => { const all = [...new Set([...body.matchAll(re)].map((m) => m[1].replace(/^0+/, '')))]; return all.length === 1 ? all[0] : null; };
  return { truck: one(/\b(?:truck|trk|tk|tr|unit|tractor|cami[oó]n)\s*#?:?\s*(\d{3,5})\b/gi), trailer: one(/\b(?:trailer|trl|tl|remolque)\s*#?:?\s*(\d{3,7})\b/gi), trip: one(/\b(?:trip|viaje|to)\s*#?:?\s*(\d{6})\b/gi) };
}
const digits = (x) => String(x || '').replace(/^0+/, '').toUpperCase();
const stateOf = (x) => (String(x || '').match(/,\s*([A-Z]{2})\b/i) || [])[1];
const cityOf = (x) => String(x || '').split(',')[0].trim().toUpperCase();
const samePlace = (a, b) => !!a && !!b && String(stateOf(a)).toUpperCase() === String(stateOf(b)).toUpperCase() && !!stateOf(a) && (cityOf(a) === cityOf(b) || cityOf(a).includes(cityOf(b)) || cityOf(b).includes(cityOf(a)));
// Does this trip run the rate con's route? 'both', 'one' or null, by pickup and delivery. Pure.
export function routeMatch(rc, it) {
  const t = tripOf(it);
  const pick = samePlace(rc.pickup, t.origZoneDesc);
  const drop = [t.destZoneDesc, ...billsOf(it).map((b) => b.endZoneDescription)].some((z) => samePlace(rc.delivery, z));
  return pick && drop ? 'both' : pick || drop ? 'one' : null;
}

// The rate con's load on the board, once it has a trip and a truck. → { it, by } | null. Pure.
// Sure things first: the trip, the bill, the broker's load number. Then the truck or trailer, but never on its own: Gus's rate cons name trucks
// still on another run, so it has to be a trip that wasn't there when the rate con came, or one waiting to start on the same route. Two candidates: it waits.
export function findLoad(entry, items = []) {
  const ready = (x) => (x && tripNo(x) && tripOf(x).powerUnit ? x : null);
  // a trip or bill number can be misread off a scan, so it has to agree with the load number or the route. Accounting never gets a guess
  const byLoad = (x) => !!entry.rc.loadNumber && (carries(x, { rc: { loadNumber: entry.rc.loadNumber } }) || same((x._ratecon && x._ratecon.data && x._ratecon.data.loadNumber), entry.rc.loadNumber));
  const agrees = (x) => byLoad(x) || (!entry.rc.pickup && !entry.rc.delivery) || !!routeMatch(entry.rc, x);
  const named = entry.trip && ready(items.find((x) => tripNo(x) === entry.trip && agrees(x)));
  if (named) return { it: named, by: `trip ${entry.trip}` };
  const exact = ready(items.find(byLoad)) || ready(items.find((x) => entry.rc.bill && carries(x, { rc: { bill: entry.rc.bill } }) && agrees(x)));
  if (exact) return { it: exact, by: byLoad(exact) ? 'load number' : 'bill' };
  const truck = digits(entry.rc.truck); const trailer = digits(entry.rc.trailer);
  if (!truck && !trailer) return null;
  const seen = new Set(entry.seenTrips || []);
  const hits = items.filter((x) => {
    if (!ready(x)) return false;
    const onTruck = truck && digits(tripOf(x).powerUnit) === truck; const onTrailer = trailer && digits(tripOf(x).trailer) === trailer;
    if (!onTruck && !onTrailer) return false;
    if (DONE.test(String(tripOf(x).status || ''))) return false;
    const route = routeMatch(entry.rc, x);
    if (!seen.has(tripNo(x))) return !entry.rc.pickup && !entry.rc.delivery ? onTruck && onTrailer : !!route;
    return BOOKED.test(String(tripOf(x).status || '')) && route === 'both';
  });
  return hits.length === 1 ? { it: hits[0], by: [truck && digits(tripOf(hits[0]).powerUnit) === truck && `truck ${truck}`, trailer && digits(tripOf(hits[0]).trailer) === trailer && `trailer ${trailer}`, routeMatch(entry.rc, hits[0]) && 'route'].filter(Boolean).join(', ') } : null;
}
export const loadOnBoard = (entry, items = []) => { const f = findLoad(entry, items); return f ? f.it : null; };

const place = (s) => (s ? [s.city, s.state].filter(Boolean).join(', ') : null);
const brief = (rc) => ({ broker: rc.broker || null, loadNumber: rc.loadNumber || null, bill: rc.fbfBillNumber || null, truck: rc.truckNumber || null, trailer: rc.trailerNumber || null, rate: rc.rate != null ? rc.rate : null, accessorials: (rc.accessorials || []).map(String).slice(0, 10), pickup: place((rc.pickups || [])[0]), delivery: place((rc.deliveries || [])[(rc.deliveries || []).length - 1]) });
export function loadFacts(entry, it = null) {
  const t = tripOf(it); const s = (it && it._samsara) || {};
  return [['Trip', it ? tripNo(it) : null], ['Bill', it ? billsOf(it).map((b) => b.billNumber).filter(Boolean).join(', ') : entry.rc.bill], ['Broker', entry.rc.broker], ['Broker load', entry.rc.loadNumber], ['Truck', (it && t.powerUnit) || entry.rc.truck], ['Trailer', it ? t.trailer : null], ['Driver', [s.driver1, s.driver2].filter(Boolean).join(' / ')], ['Pickup', entry.rc.pickup], ['Delivery', entry.rc.delivery], ['Rate', money(entry.rc.rate)], ['Matched by', entry.matchedBy]].filter(([, v]) => v);
}
const table = (rows) => `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:560px;font-size:15px">${rows.map(([k, v]) => `<tr><td style="padding:7px 10px;border:1px solid #E2E8F0;color:#596A7F;width:130px">${esc(k)}</td><td style="padding:7px 10px;border:1px solid #E2E8F0;color:#172538">${esc(v)}</td></tr>`).join('')}</table>`;
const page = (title, lead, inner) => `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#172538;max-width:600px"><h2 style="margin:0 0 6px;font-size:20px">${esc(title)}</h2><p style="margin:0 0 14px">${esc(lead)}</p>${inner}<p style="margin:16px 0 0;color:#596A7F;font-size:13px">Jarvis, Florida Beauty dispatch. Internal.</p></div>`;
const plain = (title, lead, rows, extra = '') => `${title}\n${lead}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}${extra ? `\n\n${extra}` : ''}`;

// Step 1: the team's copy, with Gus's own words. Pure.
export function renderForInbound({ entries, from = 'Gus', text = '' }) {
  const n = entries.length; const e = entries[0];
  const subject = n === 1 ? `NEW RATE CON // ${[e.rc.broker, e.rc.loadNumber && `LOAD ${e.rc.loadNumber}`, e.rc.truck && `TK ${e.rc.truck}`].filter(Boolean).join(' // ') || 'LOAD TO ENTER'}` : `NEW RATE CONS // ${n} LOADS TO ENTER`;
  const lead = `${from} sent ${n === 1 ? 'this rate con' : `these ${n} rate cons`} to enter in the system. Accounting gets ${n === 1 ? 'it' : 'them'} once the load has a trip and a truck.`;
  const blocks = entries.map((x) => table(loadFacts(x).filter(([k]) => k !== 'Rate'))).join('<br>');
  const words = String(text || '').trim();
  const html = page(n === 1 ? 'New rate con' : `${n} new rate cons`, lead, `${blocks}${words ? `<h3 style="margin:16px 0 6px;font-size:16px">${esc(from)}'s email</h3><div style="white-space:pre-wrap;border-left:3px solid #BFDBFE;padding-left:10px">${esc(words.slice(0, 8000))}</div>` : ''}`);
  return { subject, html, text: `${lead}\n\n${entries.map((x) => loadFacts(x).filter(([k]) => k !== 'Rate').map(([k, v]) => `${k}: ${v}`).join('\n')).join('\n\n')}${words ? `\n\n${from}'s email:\n${words.slice(0, 8000)}` : ''}` };
}

// Steps 2 and 3: Accounting / Billing, with the load's information. Pure.
export function renderForAccounting(entry, it = null, earlier = null) {
  const rows = loadFacts(entry, it); const t = tripOf(it);
  const label = entry.kind === 'tonu' ? 'TONU' : entry.kind === 'revised' ? 'REVISED RATE CON' : 'RATE CON';
  const ids = [(t.powerUnit || entry.rc.truck) && `TK ${t.powerUnit || entry.rc.truck}`, t.trailer && `TL ${t.trailer}`, it && `TO ${tripNo(it)}`].filter(Boolean).join(' ');
  const subject = [label, ids, [entry.rc.broker, entry.rc.loadNumber && `LOAD ${entry.rc.loadNumber}`].filter(Boolean).join(' ')].filter(Boolean).join(' // ');
  const changes = entry.kind === 'new' ? [] : whatChanged(entry.rc, earlier);
  const lead = entry.kind === 'new' ? 'This load is in TruckMate. The rate con is attached.' : `${entry.kind === 'tonu' ? 'Truck ordered, not used.' : 'The rate con changed.'} ${it ? '' : 'The load is not in TruckMate yet. '}Details below, rate con attached.`.replace('  ', ' ');
  const html = page(entry.kind === 'tonu' ? 'TONU' : entry.kind === 'revised' ? 'Revised rate con' : 'Rate con', lead, `${table(rows)}${changes.length ? `<h3 style="margin:16px 0 6px;font-size:16px">What changed</h3><ul style="margin:0;padding-left:20px">${changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}`);
  return { subject, html, text: plain(subject, lead, rows, changes.length ? `What changed:\n${changes.join('\n')}` : '') };
}

export function initRateConFlow({ db, docs = null, sendMail, recipients, saveOnLoad = null, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const all = async (site) => ((await db.get(KEY(site), { list: [] })) || {}).list || [];
  const put = (site, fn) => db.update(KEY(site), (cur) => ({ list: fn(((cur && cur.list) || [])).slice(0, KEEP) }), { list: [] });
  const patch = (site, id, fields) => put(site, (l) => l.map((x) => (x.id === id ? { ...x, ...fields } : x)));

  async function files(site, entries) {
    const ids = [...new Set(entries.flatMap((e) => e.docIds || []))];
    if (!ids.length || !docs || !docs.readDocs) return { attachments: [], left: 0 };
    let room = ROOM; let left = 0; const attachments = [];
    const load = entries.length === 1 && entries[0].rc.loadNumber ? `-${String(entries[0].rc.loadNumber).replace(/[^A-Za-z0-9-]/g, '')}` : '';
    for (const [i, f] of (await docs.readDocs({ site, ids })).entries()) {
      if (!f.data || f.data.length > room) { left += 1; continue; }
      room -= f.data.length;
      const ext = /pdf/i.test(f.mediaType || 'pdf') ? 'pdf' : String(f.mediaType).split('/')[1] || 'jpg';
      attachments.push({ name: `RateCon${load}-${i + 1}.${ext}`, contentType: f.mediaType || 'application/pdf', bytes: f.data });
    }
    return { attachments, left };
  }
  const note = (m, left) => (left ? { ...m, html: `${m.html}<p>${left} file${left === 1 ? ' is' : 's are'} too large to attach. Open ${left === 1 ? 'it' : 'them'} on the load.</p>`, text: `${m.text}\n\n${left} file(s) too large to attach.` } : m);

  async function toBilling(site, entry, it, earlier) {
    const to = await recipients('ratecon_accounting');
    if (!to.length) throw new Error('No one is set for rate con emails.');
    const { attachments, left } = await files(site, [entry]);
    await sendMail({ ...note(renderForAccounting(entry, it, earlier), left), to, attachments });
  }

  // Rate cons just read from Gus's email. entries: [{ trip, pendingId }] from the filer.
  async function received(site, { email, entries = [], items = [], fullText = '', alreadyWithTeam = false }) {
    if (!enabled || !entries.length) return { added: 0 };
    const pending = (await db.get(`taRateConPending:${site}`, [])) || [];
    const saved = (await db.get(`taTruckMateRateCon:${site}`, {})) || {};
    const list = await all(site);
    const fresh = []; const changed = [];
    for (const [i, e] of entries.entries()) {
      const rec = e.pendingId ? (pending.find((p) => p.id === e.pendingId) || {}).record : (e.trip ? saved[e.trip] : null);
      if (!rec) continue;
      const rc = brief(rec);
      const ids = idsFromEmail({ subject: email.subject, text: fullText || email.text, loadNumber: rc.loadNumber, single: entries.length === 1 });
      rc.truck = rc.truck || ids.truck; rc.trailer = rc.trailer || ids.trailer;
      const namedTrip = e.trip || (ids.trip && items.some((x) => tripNo(x) === ids.trip) ? ids.trip : null);
      const earlier = rc.loadNumber ? list.find((x) => same(x.rc.loadNumber, rc.loadNumber)) || null : null;
      const kind = kindOf({ subject: email.subject, text: email.text, rc: rec, filename: rec.filename }, earlier);
      if (kind === 'new' && earlier) continue;   // the same rate con again
      const entry = { id: `rc${now().toString(36)}${i}`, at: new Date(now()).toISOString(), kind, by: email.from.name || email.from.address, emailId: email.id, subject: String(email.subject || '').slice(0, 200), trip: namedTrip, seenTrips: items.filter((x) => [digits(tripOf(x).powerUnit), digits(tripOf(x).trailer)].some((v) => v && (v === digits(rc.truck) || v === digits(rc.trailer)))).map(tripNo), pendingId: e.pendingId || null, rc, docIds: (rec.docIds || []).slice(0, 6), status: kind === 'new' ? 'waiting' : 'sending', tries: 0 };
      fresh.push(entry);
      if (kind !== 'new') changed.push({ entry, earlier });
    }
    if (!fresh.length) return { added: 0 };
    await put(site, (l) => [...fresh, ...l]);
    const newOnes = fresh.filter((x) => x.kind === 'new');
    if (newOnes.length && !alreadyWithTeam) {
      try {
        const to = await recipients('ratecon_inbound');
        const { attachments, left } = await files(site, newOnes);
        await sendMail({ ...note(renderForInbound({ entries: newOnes, from: email.from.name || 'Gus', text: fullText || email.text }), left), to, attachments });
        await put(site, (l) => l.map((x) => (newOnes.some((n) => n.id === x.id) ? { ...x, forwardedAt: new Date(now()).toISOString() } : x)));
      } catch (e) { console.warn('[rate-con flow] inbound:', e.message); await put(site, (l) => l.map((x) => (newOnes.some((n) => n.id === x.id) ? { ...x, forwardError: e.message } : x))); }
    }
    for (const { entry, earlier } of changed) {
      try { await toBilling(site, entry, loadOnBoard(entry.trip ? entry : { ...entry, trip: earlier && earlier.foundTrip }, items), earlier); await patch(site, entry.id, { status: 'sent', sentAt: new Date(now()).toISOString() }); } catch (e) { console.warn('[rate-con flow] billing:', e.message); await patch(site, entry.id, { status: 'waiting', error: e.message }); } // eslint-disable-line no-await-in-loop
    }
    return { added: fresh.length };
  }

  // Every board refresh: rate cons whose load has made it into TruckMate go to Accounting.
  async function process(site, board) {
    if (!enabled) return;
    const items = (board && board.trips) || [];
    const waiting = (await all(site)).filter((x) => x.status === 'waiting');
    for (const entry of waiting) {
      if (now() - Date.parse(entry.at) > WATCH_DAYS * DAY) { await patch(site, entry.id, { status: 'expired' }); continue; } // eslint-disable-line no-await-in-loop
      const found = findLoad(entry, items);
      if (!found) continue;
      const { it } = found;
      let mine = false;
      await put(site, (l) => l.map((x) => { if (x.id !== entry.id || x.status !== 'waiting') return x; mine = true; return { ...x, status: 'sending' }; })); // eslint-disable-line no-await-in-loop
      if (!mine) continue;
      try {
        if (saveOnLoad) await saveOnLoad(site, tripNo(it), entry); // eslint-disable-line no-await-in-loop
        await toBilling(site, { ...entry, matchedBy: found.by }, it, null); // eslint-disable-line no-await-in-loop
        await patch(site, entry.id, { status: 'sent', sentAt: new Date(now()).toISOString(), foundTrip: tripNo(it), matchedBy: found.by }); // eslint-disable-line no-await-in-loop
      } catch (e) {
        const tries = (entry.tries || 0) + 1;
        console.warn('[rate-con flow] accounting:', e.message);
        await patch(site, entry.id, { status: tries >= MAX_TRIES ? 'failed' : 'waiting', tries, error: e.message }); // eslint-disable-line no-await-in-loop
      }
    }
  }
  return { received, process, list: all };
}
