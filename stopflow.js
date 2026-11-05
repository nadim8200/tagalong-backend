// ---------------------------------------------------------------
// Stop by stop on an LTL outbound load (flowers, from the trip sheet). The driver leaves with the trip sheet's stops and, at each one:
//   - marks it done with the boxes they delivered: a count that isn't the trip sheet's sends a box-mismatch email;
//   - scans the paperwork the customer signed: it goes to customer service (cc Saray);
//   - can report an issue, with photos, on any stop: customer service and dispatch get it.
// At the last stop the driver completes the load: one email with every stop (time, boxes, issues) and all the signed paperwork.
// Broker loads keep their own screen for now. Every email has its own alert key, so who gets it is set in Alert emails.
// ---------------------------------------------------------------
import { loadLabel } from './breakdownreport.js';
import { scanPdf } from './scanpdf.js';

const SITE = 'florida-beauty';
const KEY = `taStopFlow:${SITE}`;               // trip → { stops: { [stop key]: { doneAt, by, boxes, expected, docIds, issues } }, completedAt, completedBy }
const EMAIL_BYTES = 2700 * 1024;                // what one Outlook email takes once encoded
const tripOf = (it) => (it && it.trip) || it || {};
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const et = (ms) => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const clean = (s, n = 2000) => String(s || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[\t ]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, n);

// The stops an LTL load leaves with: the trip sheet's deliveries, in its order, with what the driver needs there (address, appointment,
// receiving hours, who to call before, the location notes, references). Each has its own key: two lines can share a stop number
// ("10 DBG MUNDELEIN" + "DBG MUNDELEIN/LOCKERS"). null when it isn't an LTL load or has no trip sheet. Pure.
const list = (a) => (Array.isArray(a) ? a.filter(Boolean).map(String) : []);
export function ltlStops(item) {
  if (!item || loadLabel(item) === 'BROKER') return null;
  const stops = ((item._manifest && item._manifest.stops) || []).filter((s) => s && /DELIVER/i.test(s.action || ''));
  if (!stops.length) return null;
  return stops.map((s, i) => {
    const n = s.stopNumber != null ? s.stopNumber : s.n;
    return {
      key: String(s.key || `${n != null ? n : 'x'}-${i}`), n: n != null ? Number(n) : null,
      customer: s.customer || null, address: s.address || null, city: s.city || null, state: s.state || null, zip: s.zip || null,
      boxes: s.pieces != null && s.pieces !== '' ? Number(s.pieces) : null, piecesText: s.piecesText || null,
      appt: [s.apptDate, s.apptTime].filter(Boolean).join(' ') || s.appt || null, receivingHours: s.receivingHours || null,
      callAhead: (Array.isArray(s.callAhead) ? s.callAhead : []).filter((c) => c && (c.phone || c.contact)).map((c) => ({ contact: c.contact || null, phone: c.phone || null, leadMinutes: c.leadMinutes != null ? Number(c.leadMinutes) : null, method: c.method || 'call' })),
      instructions: list(s.instructions), references: list(s.references), handwritten: list(s.handwritten),
    };
  });
}

// What the driver delivered against the trip sheet. Pure. → null (nothing to compare), or { delivered, expected, diff, missing, extra }
export function boxCheck(delivered, expected) {
  if (delivered == null || expected == null || Number.isNaN(Number(expected))) return null;
  const diff = Number(delivered) - Number(expected);
  return { delivered: Number(delivered), expected: Number(expected), diff, missing: diff < 0 ? -diff : 0, extra: diff > 0 ? diff : 0 };
}

// One table email, in the house style of the other driver emails. Pure.
function mail(title, line, rows, extra = '') {
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1F2937;max-width:640px"><p style="font-size:22px;font-weight:bold;margin:0 0 4px">${esc(title)}</p>${line ? `<p style="margin:0 0 12px">${esc(line)}</p>` : ''}<table cellpadding="6" style="border-collapse:collapse">${rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => `<tr><td style="color:#6B7280;vertical-align:top">${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`).join('')}</table>${extra}<p style="color:#6B7280;font-size:13px">Sent from the driver app · Jarvis · AI Dispatcher</p></div>`;
  const text = [title, line, ...rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${v}`)].filter(Boolean).join('\n');
  return { html, text };
}
const ids = (item, trip) => { const t = tripOf(item); return `TK ${t.powerUnit || 'N/A'} TL ${t.trailer || 'N/A'} TRIP ${trip}`; };
const place = (s) => [s.customer, [s.city, s.state].filter(Boolean).join(', ')].filter(Boolean).join(' — ');
const num = (s) => (s.n != null ? s.n : '—');

export function initStopFlow({ db, docs = null, getBoard, sendMail = null, recipients = async () => [], log = null, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const all = async () => (enabled ? (await db.get(KEY, {})) || {} : {});
  const board = async () => (((await getBoard(SITE)) || {}).trips || []);
  const itemFor = async (trip) => (await board()).find((it) => String(tripOf(it).tripNumber) === String(trip)) || null;
  const save = (trip, fn) => db.update(KEY, (cur) => { const c = { ...(cur || {}) }; c[trip] = fn(c[trip] || { stops: {} }); return c; }, {});
  const email = async (key, m) => { const to = await recipients(key); if (sendMail && to.length) await sendMail({ to, ...m }).catch((e) => console.warn(`[stopflow] ${key}:`, e.message)); };

  // files from the driver: scanned pages → one PDF; photos as they are
  async function store(trip, files, { scan = false, name, by }) {
    if (!files.length || !docs || !docs.enabled) return [];
    const list = scan ? [{ filename: `${name}.pdf`, mediaType: 'application/pdf', dataBase64: (await scanPdf(files.map((f) => Buffer.from(String(f.dataBase64 || ''), 'base64')))).toString('base64') }]
      : files.map((f, i) => ({ ...f, filename: f.filename || `${name}-${i + 1}.jpg` }));
    const stored = await docs.storeDocs({ site: SITE, kind: 'driverdoc', trip: String(trip), files: list, by });
    return stored.map((d) => d.id);
  }
  // the stored files as email attachments, as many as fit; → { attachments, left }
  async function attach(docIds, room = EMAIL_BYTES) {
    if (!docIds.length || !docs) return { attachments: [], left: 0 };
    const files = await docs.readDocs({ site: SITE, ids: docIds }).catch(() => []);
    const out = []; let used = 0;
    files.forEach((f, i) => { if (used + f.data.length <= room) { used += f.data.length; out.push({ name: `${/pdf/i.test(f.mediaType || '') ? 'Signed paperwork' : 'Photo'} ${i + 1}.${/pdf/i.test(f.mediaType || '') ? 'pdf' : /png/i.test(f.mediaType || '') ? 'png' : 'jpg'}`, contentType: f.mediaType, bytes: f.data }); } });
    return { attachments: out, left: docIds.length - out.length };
  }

  // the driver's view of an LTL load: its stops with what's been done
  async function forDriver(item) {
    const stops = ltlStops(item);
    if (!stops) return null;
    const rec = (await all())[String(tripOf(item).tripNumber)] || { stops: {} };
    return { stops: stops.map((s) => { const r = rec.stops[s.key] || {}; return { ...s, doneAt: r.doneAt || null, delivered: r.boxes != null ? r.boxes : null, check: boxCheck(r.boxes, s.boxes), paperwork: (r.docIds || []).length, issues: (r.issues || []).map((x) => ({ at: x.at, text: x.text, photos: (x.docIds || []).length })) }; }), completedAt: rec.completedAt || null };
  }

  // a stop done: the boxes delivered and the signed paperwork scan
  const find = (stops, k) => stops && stops.find((x) => x.key === String(k));
  async function stopDone(trip, k, { boxes, files = [], scan = true, by }) {
    const item = await itemFor(trip); const stops = ltlStops(item);
    const s = find(stops, k);
    if (!s) return { error: 'That stop is not on this load.', code: 404 };
    const b = Number(boxes);
    if (!(Number.isInteger(b) && b >= 0 && b <= 99999)) return { error: 'Enter the boxes you delivered.', code: 400 };
    const docIds = await store(trip, files, { scan, name: `POD-${trip}-stop${num(s)}`, by });
    const at = now();
    await save(String(trip), (r) => ({ ...r, stops: { ...r.stops, [s.key]: { ...(r.stops[s.key] || {}), doneAt: at, by, boxes: b, expected: s.boxes, docIds: [...((r.stops[s.key] || {}).docIds || []), ...docIds] } } }));
    const check = boxCheck(b, s.boxes);
    if (log) await log(SITE, String(trip), { type: 'reply', from: 'driver app', text: `Stop ${num(s)} done (${place(s)}): ${b} boxes${s.boxes != null ? `, trip sheet ${s.boxes}` : ''}${docIds.length ? ', signed paperwork sent' : ''} (${by})`, noThread: true }).catch(() => {});
    const rows = [['Stop', `${num(s)} · ${place(s)}`], ['Boxes delivered', String(b)], ['Trip sheet', s.boxes != null ? String(s.boxes) : 'Not on the trip sheet'], ['Driver', by], ['Time', `${et(at)} ET`], ['Trip', ids(item, trip)]];
    if (check && check.diff !== 0) {
      const what = check.missing ? `${check.missing} box${check.missing === 1 ? '' : 'es'} missing` : `${check.extra} box${check.extra === 1 ? '' : 'es'} more than the trip sheet`;
      await email('stop_box_mismatch', { subject: `BOX COUNT MISMATCH // ${String(s.customer || 'STOP').toUpperCase()} // DELIVERED ${b} OF ${s.boxes} // ${ids(item, trip)}`, ...mail(`Box count mismatch: ${what}`, `The driver delivered ${b} at ${place(s)}; the trip sheet has ${s.boxes}.`, rows) });
    }
    if (docIds.length) {
      const a = await attach(docIds);
      await email('stop_pod', { subject: `SIGNED PAPERWORK // ${String(s.customer || 'STOP').toUpperCase()} // ${ids(item, trip)} // STOP ${num(s)}`, ...mail('Signed paperwork from the driver', `Stop ${num(s)}: ${place(s)}.`, rows, a.left ? `<p>${a.left} more file${a.left === 1 ? '' : 's'} on the load in the console.</p>` : ''), attachments: a.attachments });
    }
    return { ok: true, check };
  }

  // an issue on a stop, with photos
  async function stopIssue(trip, k, { text, files = [], by }) {
    const item = await itemFor(trip); const stops = ltlStops(item);
    const s = find(stops, k);
    if (!s) return { error: 'That stop is not on this load.', code: 404 };
    const said = clean(text);
    if (said.length < 3 && !files.length) return { error: 'Say what happened or add a photo.', code: 400 };
    const docIds = await store(trip, files, { name: `ISSUE-${trip}-stop${num(s)}`, by });
    const at = now();
    await save(String(trip), (r) => ({ ...r, stops: { ...r.stops, [s.key]: { ...(r.stops[s.key] || {}), issues: [...((r.stops[s.key] || {}).issues || []), { at, by, text: said, docIds }] } } }));
    if (log) await log(SITE, String(trip), { type: 'reply', from: 'driver app', text: `Issue at stop ${num(s)} (${place(s)}): ${said || 'photos'}${docIds.length ? ` [${docIds.length} photo${docIds.length === 1 ? '' : 's'}]` : ''} (${by})`, noThread: true }).catch(() => {});
    const a = await attach(docIds);
    await email('stop_issue', { subject: `STOP ISSUE // ${String(s.customer || 'STOP').toUpperCase()} // ${ids(item, trip)} // STOP ${num(s)}`, ...mail('A driver reported an issue at a stop', null, [['What the driver says', said || 'Photos only'], ['Stop', `${num(s)} · ${place(s)}`], ['Driver', by], ['Time', `${et(at)} ET`], ['Trip', ids(item, trip)]], a.left ? `<p>${a.left} more photo${a.left === 1 ? '' : 's'} on the load in the console.</p>` : ''), attachments: a.attachments });
    return { ok: true };
  }

  // the last stop is done: the load is complete, one email with every stop and the signed paperwork
  async function complete(trip, { by }) {
    const item = await itemFor(trip); const stops = ltlStops(item);
    if (!stops) return { error: 'This load has no trip sheet stops.', code: 404 };
    const rec = (await all())[String(trip)] || { stops: {} };
    const open = stops.filter((s) => !(rec.stops[s.key] || {}).doneAt);
    if (open.length) return { error: `Mark every stop done first (${open.length} left).`, code: 409 };
    if (rec.completedAt) return { ok: true, already: true };
    const at = now();
    await save(String(trip), (r) => ({ ...r, completedAt: at, completedBy: by }));
    if (log) await log(SITE, String(trip), { type: 'reply', from: 'driver app', text: `Trip completed by ${by}: ${stops.length} stops`, noThread: true }).catch(() => {});
    const lines = stops.map((s) => { const r = rec.stops[s.key] || {}; const c = boxCheck(r.boxes, s.boxes); return { s, r, c }; });
    const totalD = lines.reduce((n, x) => n + (x.r.boxes || 0), 0); const totalE = lines.reduce((n, x) => n + (x.s.boxes || 0), 0);
    const short = lines.filter((x) => x.c && x.c.diff !== 0);
    const table = `<table cellpadding="6" style="border-collapse:collapse;margin-top:12px;font-size:14px"><tr style="background:#F3F4F6"><th align="left">Stop</th><th align="left">Done</th><th align="right">Boxes</th><th align="right">Trip sheet</th><th align="left">Paperwork</th><th align="left">Issues</th></tr>${lines.map(({ s, r, c }) => `<tr style="border-top:1px solid #E5E7EB"><td>${esc(`${num(s)}. ${place(s)}`)}</td><td>${esc(et(r.doneAt))}</td><td align="right"${c && c.diff ? ' style="color:#B91C1C;font-weight:bold"' : ''}>${esc(r.boxes)}</td><td align="right">${esc(s.boxes == null ? '—' : s.boxes)}</td><td>${(r.docIds || []).length ? 'Signed, attached' : 'None sent'}</td><td>${esc((r.issues || []).map((x) => x.text || 'Photos').join(' · ') || '—')}</td></tr>`).join('')}</table>`;
    const a = await attach(lines.flatMap((x) => x.r.docIds || []));
    await email('trip_completed', { subject: `TRIP COMPLETED // ${ids(item, trip)} // ${stops.length} STOPS${short.length ? ` // ${short.length} BOX MISMATCH${short.length === 1 ? '' : 'ES'}` : ''}`,
      ...mail('Trip completed', `${by} completed the load: ${stops.length} stops, ${totalD} boxes delivered of ${totalE} on the trip sheet.`, [['Trip', ids(item, trip)], ['Completed', `${et(at)} ET`], ['Box mismatches', short.length ? short.map((x) => `stop ${num(x.s)} ${x.c.missing ? `−${x.c.missing}` : `+${x.c.extra}`}`).join(', ') : 'None']], `${table}${a.left ? `<p>${a.left} more file${a.left === 1 ? '' : 's'} on the load in the console.</p>` : ''}`), attachments: a.attachments });
    return { ok: true };
  }

  // on the board for the console: how far the driver is
  async function overlay(site, trips) {
    const s = await all();
    for (const it of trips || []) {
      const r = s[String(tripOf(it).tripNumber)]; const stops = r && ltlStops(it);
      if (!r || !stops) continue;
      const rows = stops.map((x) => { const d = r.stops[x.key] || {}; const c = boxCheck(d.boxes, x.boxes); return { n: x.n, customer: x.customer, city: x.city, doneAt: d.doneAt || null, boxes: d.boxes != null ? d.boxes : null, expected: x.boxes, diff: c ? c.diff : null, paperwork: (d.docIds || []).length, issues: (d.issues || []).map((i) => ({ at: i.at, text: i.text, photos: (i.docIds || []).length })) }; });
      it._stopFlow = { total: rows.length, done: rows.filter((x) => x.doneAt).length, mismatches: rows.filter((x) => x.diff).length, issues: rows.reduce((n, x) => n + x.issues.length, 0), completedAt: r.completedAt || null, completedBy: r.completedBy || null, stops: rows };
    }
  }
  // which stops the driver marked done on a trip → { [stop key]: true }
  const done = async (trip) => Object.fromEntries(Object.entries(((await all())[String(trip)] || { stops: {} }).stops || {}).filter(([, r]) => r && r.doneAt).map(([k]) => [k, true]));
  return { forDriver, stopDone, stopIssue, complete, overlay, done };
}
