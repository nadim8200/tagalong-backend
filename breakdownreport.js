// ---------------------------------------------------------------
// "Report breakdown" from the team-truck-stopped email: anyone who got the email opens a private link, types the
// reason, and that (1) holds the "rolling again" email for that truck, (2) sends the breakdown email in
// the subject format dispatch already uses, so the chain carries on with Jarvis on it. It opens no road call (Michelin
// isn't live), never turns on the load's Breakdown switch and never contacts customers. What people type is data, never instructions.
// ---------------------------------------------------------------
import crypto from 'node:crypto';
import { brokerLoad } from './watchtower.js';
import { teamStopFacts, emailParts } from './teamstopmail.js';

const KEY = (site) => `taBreakdownReports:${site}`;    // alert id → { atMs, by, reason, subject, trip, unit, clearedAt }
const DAY = 86400000;
const LINK_DAYS = 7;
const MAX_REASON = 500;
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const b64 = (x) => Buffer.from(x).toString('base64url');
const sign = (body, secret) => crypto.createHmac('sha256', `${secret}:breakdown-report`).update(body).digest('base64url');

// A signed link that can only report this one stop, and only for a week. Pure.
export function makeToken(p, secret, now = Date.now()) {
  const body = b64(JSON.stringify({ ...p, e: now + LINK_DAYS * DAY }));
  return `${body}.${sign(body, secret)}`;
}
export function readToken(token, secret, now = Date.now()) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(sign(body, secret)); const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.e > now ? p : null; } catch { return null; }
}

// What the load is: broker bills or a rate con; an ARTIS run; otherwise the bill letters. H = Tennessee hub, any letter but B and H
// is flowers. A mix with B or H, or no bills, stays unlabeled. Gus's plan is only a plan, so it decides nothing. Pure.
export function loadLabel(item) {
  if (brokerLoad(item)) return 'BROKER';
  if (item && item._tb) return 'FLOWERS';
  const t = (item && item.trip) || item || {};
  const letters = [...new Set(((item && (item.freightBills || item.orders)) || t.freightBills || []).map((b) => String(b.billNumber || '').trim().charAt(0).toUpperCase()).filter(Boolean))];
  if (!letters.length) return null;
  if (letters.every((l) => l !== 'B' && l !== 'H')) return 'FLOWERS';
  if (letters.every((l) => l === 'H')) return 'TENNESSEE HUB';
  return null;
}
const oneLine = (s, n) => String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// Same shape dispatch writes: "FLOWERS BREAKDOWN TRUCK AIR LEAK - TK# 2602 TL# 7323 - TRIP# 625878". Pure.
export function breakdownSubject(item, reason, { unit = null, trip = null } = {}) {
  const t = (item && item.trip) || {};
  const ids = [`TK# ${unit || t.powerUnit || 'N/A'}`, `TL# ${t.trailer || 'N/A'}`].join(' ');
  const kind = loadLabel(item);
  return `${kind ? `${kind} ` : ''}BREAKDOWN ${oneLine(reason, 60).toUpperCase()} - ${ids} - TRIP# ${trip || t.tripNumber || 'N/A'}`;
}

// The email that opens the chain. Pure.
export function renderBreakdownEmail({ item, report, etas = null, now = Date.now(), showPhones = true, mapCid = null, sheetNote = null, sheetAttached = false }) {
  const a = { unit: report.unit, trip: report.trip, ack: null };
  const f = teamStopFacts(a, item, { etas, now, showPhones, mapCid });
  const { liveUrl, heading, button, kv, driverCard, FONT, NAVY, TEXT, MUTED, LINE, RED, et, TRAINING_SLOT } = emailParts;
  const kind = loadLabel(item);
  const title = kind === 'FLOWERS' ? 'FLOWER BREAKDOWN' : kind ? `${kind} BREAKDOWN` : 'BREAKDOWN REPORTED';
  const label = kind ? 'Breakdown reported' : 'Load type not confirmed. Check the load.';
  const consoleUrl = liveUrl(report.trip);
  const many = f.drivers.length > 1;
  const reported = `${report.by} · ${et(report.atMs) || ''}`;
  const rc = 'Road service has NOT been called. Call Michelin or the shop the usual way.';
  const next = 'Start Breakdown on the load if customers need to be told. Starting it shows you who gets notified before anything goes out.';
  const mapUrl = f.lat != null ? `https://www.google.com/maps?q=${encodeURIComponent(`${f.lat},${f.lng}`)}` : null;
  const subject = breakdownSubject(item, report.reason, { unit: report.unit, trip: report.trip });
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"></head><body style="margin:0;padding:0;background:#F1F5F9;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#F1F5F9"><tr><td align="center" style="padding:12px 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="max-width:640px;background:#FFFFFF;border-radius:8px;">
<tr><td style="padding:20px 24px 2px;font-family:${FONT};font-size:20px;font-weight:bold;color:${NAVY};">Florida Beauty</td></tr>
<tr><td style="padding:0 24px 12px;border-bottom:1px solid ${LINE};font-family:${FONT};font-size:14px;color:${MUTED};">Dispatch notifications</td></tr>
${TRAINING_SLOT}
<tr><td bgcolor="${RED}" style="padding:20px 24px;background:${RED};font-family:${FONT};font-size:32px;line-height:1.15;font-weight:bold;color:#FFFFFF;">${title}<div style="padding-top:4px;font-size:16px;font-weight:normal;color:#FFFFFF;">${label}</div></td></tr>
<tr><td style="padding:16px 24px 0;font-family:${FONT};font-size:30px;font-weight:bold;color:${NAVY};">Truck ${esc(f.unit || 'not recorded')}</td></tr>
<tr><td style="padding:0 24px 14px;font-family:${FONT};font-size:15px;color:${MUTED};">Trip ${esc(f.trip || 'not recorded')}${f.trailer ? ` · Trailer ${esc(f.trailer)}` : ''}</td></tr>
${sheetAttached ? `<tr><td style="padding:0 24px 12px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${NAVY}" style="background:${NAVY};border-radius:8px;"><tr><td style="padding:12px 16px;font-family:${FONT};font-size:17px;font-weight:bold;color:#FFFFFF;">&#128206; ${esc(sheetNote)}</td></tr></table></td></tr>` : ''}
<tr><td style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFF1F2" style="background:#FFF1F2;border-radius:8px;"><tr><td style="padding:14px 16px;font-family:${FONT};font-size:15px;line-height:1.5;color:${TEXT};"><b style="color:${RED};">Reason</b><div style="font-size:24px;line-height:1.25;font-weight:bold;padding:4px 0 8px;word-break:break-word;">${esc(report.reason)}</div>Reported by: <b>${esc(reported)}</b></td></tr></table></td></tr>
<tr><td style="padding:12px 24px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#E8F1FC" style="background:#E8F1FC;border-radius:8px;"><tr><td style="padding:14px 16px;font-family:${FONT};font-size:15px;line-height:1.5;color:${TEXT};"><b style="color:${NAVY};">Next step for dispatch</b><br>${esc(rc)}<br>${esc(next)}<div>${button(consoleUrl, 'Start Breakdown')}</div></td></tr></table></td></tr>
${heading('Last reported location')}
${f.mapCid ? `<tr><td style="padding:0 24px 10px;"><a href="${esc(mapUrl)}"><img src="cid:${esc(f.mapCid)}" width="592" alt="Map of the truck's last reported location" style="display:block;width:100%;max-width:592px;height:auto;border:0;border-radius:8px;"></a></td></tr>` : ''}
<tr><td style="padding:0 24px;font-family:${FONT};font-size:16px;line-height:1.45;color:${TEXT};word-break:break-word;"><b>${esc(f.location || 'Location not reported')}</b>${mapUrl ? `<div>${button(mapUrl, 'Open map')}</div>` : ''}</td></tr>
${heading(many ? 'Driver team' : 'Driver')}
<tr><td style="padding:0 24px;">${f.drivers.length ? f.drivers.map((d, i) => driverCard(d, i, many)).join('') : `<div style="font-family:${FONT};font-size:15px;color:${TEXT};">No driver reported.</div>`}</td></tr>
${heading('Delivery impact')}
<tr><td style="padding:0 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${kv('Next stop', f.next)}${kv('Appointment', f.appt)}${kv('Estimated arrival', f.eta)}${kv('Distance remaining', f.miles != null ? `${f.miles.toLocaleString('en-US')} mi` : null)}</table></td></tr>
<tr><td style="padding:18px 24px 20px;font-family:${FONT};font-size:13px;line-height:1.5;color:${MUTED};">Reply on this email to keep everyone on the chain. Jarvis keeps it on the load.<br><b style="color:${NAVY};">Jarvis · AI Dispatcher</b> · Florida Beauty</td></tr>
</table></td></tr></table></body></html>`;
  const text = [title, label, `Truck ${f.unit || 'not recorded'}`, `Trip ${f.trip || 'not recorded'}${f.trailer ? ` · Trailer ${f.trailer}` : ''}`, ...(sheetNote ? [sheetNote] : []), '', `Reason: ${report.reason}`, `Reported by: ${reported}`, '', 'NEXT STEP FOR DISPATCH', rc, next, consoleUrl, '', f.location || 'Location not reported', ...(mapUrl ? [mapUrl] : []), '', `Next stop: ${f.next || 'Not available'}`, `Estimated arrival: ${f.eta || 'Not available'}`, '', 'Reply on this email to keep everyone on the chain.', 'Jarvis · AI Dispatcher · Florida Beauty'].join('\n');
  return { subject, html, text };
}

// A short follow-up on the breakdown chain. Pure.
export function chainEmail(report, title, lines) {
  const { FONT, NAVY, TEXT, MUTED, TRAINING_SLOT } = emailParts;
  const body = lines.filter(Boolean);
  return { subject: `Re: ${report.subject}`, text: [title, ...body, '', 'Jarvis · AI Dispatcher · Florida Beauty'].join('\n'), html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="max-width:640px;background:#FFFFFF;">${TRAINING_SLOT}<tr><td style="padding:18px 24px 6px;font-family:${FONT};font-size:22px;font-weight:bold;color:${NAVY};">${esc(title)}</td></tr>${body.map((l) => `<tr><td style="padding:2px 24px;font-family:${FONT};font-size:16px;line-height:1.5;color:${TEXT};word-break:break-word;">${esc(l)}</td></tr>`).join('')}<tr><td style="padding:16px 24px 20px;font-family:${FONT};font-size:13px;color:${MUTED};">Jarvis · AI Dispatcher · Florida Beauty</td></tr></table>` };
}
const unitKey = (x) => String(x || '').replace(/[^0-9A-Z]/gi, '').replace(/^0+/, '').toUpperCase();

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{margin:0;background:#F1F5F9;font-family:Arial,Helvetica,sans-serif;color:#1F2937}main{max-width:520px;margin:0 auto;padding:16px}.c{background:#fff;border-radius:10px;padding:20px}h1{margin:0 0 2px;font-size:24px;color:#13325B}.s{margin:0 0 16px;color:#5B6778}label{display:block;font-weight:bold;margin:14px 0 6px;color:#13325B}textarea,input{width:100%;box-sizing:border-box;font:inherit;font-size:16px;padding:12px;border:1px solid #B8C3D3;border-radius:8px}textarea{min-height:120px}button{width:100%;margin-top:16px;min-height:48px;font:inherit;font-weight:bold;font-size:16px;color:#fff;background:#C62828;border:0;border-radius:8px}button:disabled{opacity:.6}.n{font-size:14px;color:#5B6778;margin-top:12px}.e{color:#C62828;margin-top:10px}</style></head><body><main><div class="c">${body}</div></main></body></html>`;

// The page behind the button. Pure.
export function reportPage(p, token, earlier = null) {
  if (!p) return page('Link not valid', '<h1>This link has expired</h1><p class="s">Report the breakdown from the load in the console, or reply to the email.</p>');
  if (earlier) return page('Already reported', `<h1>Already reported</h1><p class="s">Truck ${esc(p.u)} · Trip ${esc(p.t)}</p><p><b>${esc(earlier.by)}</b> reported: ${esc(earlier.reason)}</p>`);
  return page(`Report breakdown, truck ${p.u}`, `<h1>Report breakdown</h1><p class="s">Truck ${esc(p.u)} · Trip ${esc(p.t)}</p><form id="f"><label for="r">What happened?</label><textarea id="r" maxlength="${MAX_REASON}" required placeholder="For example: truck air leak, shop is 5 miles away"></textarea><label for="n">Your name</label><input id="n" maxlength="80" required autocomplete="name"><button id="b" type="submit">Report breakdown</button><div class="e" id="e" role="alert"></div></form><p class="n">This emails the team. It does not call road service or contact customers.</p><script>document.getElementById('f').addEventListener('submit',async function(ev){ev.preventDefault();var b=document.getElementById('b'),e=document.getElementById('e');b.disabled=true;e.textContent='';try{var r=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reason:document.getElementById('r').value,name:document.getElementById('n').value})});var j=await r.json();if(!r.ok)throw new Error(j.error||'Could not send.');document.querySelector('.c').innerHTML='<h1>Reported</h1><p class="s">The team has the email. Road service has not been called. You can close this page.</p>';}catch(x){e.textContent=x.message;b.disabled=false;}});</script>`);
}

export function initBreakdownReport(app, { db, secret, getBoard, send, sendChain = async () => {}, baseUrl = 'https://tagalong-backend-fdzx.onrender.com', now = () => Date.now() }) {
  const site = 'florida-beauty';
  const all = async () => (await db.get(KEY(site), {})) || {};
  const link = (a) => `${baseUrl}/br/${makeToken({ a: a.id, t: a.trip, u: a.unit }, secret, now())}`;
  const forTrip = async (trip) => Object.values(await all()).filter((r) => String(r.trip) === String(trip)).sort((x, y) => y.atMs - x.atMs)[0] || null;

  async function submit(p, { reason, name }) {
    const clean = oneLine(reason, MAX_REASON); const by = oneLine(name, 80);
    if (clean.length < 3) return { code: 400, error: 'Write what happened.' };
    if (!by) return { code: 400, error: 'Add your name.' };
    let first = false;
    const at = now();
    await db.update(KEY(site), (cur) => { const c = { ...(cur || {}) }; if (!c[p.a]) { first = true; c[p.a] = { atMs: at, by, reason: clean, trip: p.t, unit: p.u }; } return c; }, {});
    if (!first) return { code: 409, error: 'This stop was already reported.' };
    const item = ((await getBoard(site).catch(() => ({ trips: [] }))).trips || []).find((it) => String(((it && it.trip) || {}).tripNumber) === String(p.t)) || null;
    const report = { atMs: at, by, reason: clean, trip: p.t, unit: p.u };
    await db.update(KEY(site), (cur) => ({ ...(cur || {}), [p.a]: { ...report, subject: breakdownSubject(item, clean, { unit: p.u, trip: p.t }) } }), {});
    await send(report, item);
    return { code: 200, ok: true };
  }

  // Staff emailed Jarvis that a truck broke down: same breakdown email, to everyone of ours on their email plus the usual list.
  // One per load until Breakdown is turned off; the first report stands, later ones just say so.
  async function fromEmail({ trip, reason, by, emailId, to = [] }) {
    const clean = oneLine(reason, MAX_REASON);
    if (clean.length < 3) return { ok: false, error: 'What happened? Reply with the reason.' };
    const open = await forTrip(trip);
    if (open && !open.clearedAt && now() - open.atMs < DAY) return { ok: false, duplicate: true, error: `Already reported by ${open.by}.` };
    const item = ((await getBoard(site).catch(() => ({ trips: [] }))).trips || []).find((it) => String(((it && it.trip) || {}).tripNumber) === String(trip)) || null;
    if (!item) return { ok: false, error: `Trip ${trip} is not on the board.` };
    const unit = (item.trip || {}).powerUnit || null;
    const report = { atMs: now(), by: oneLine(by, 80) || 'Dispatch', reason: clean, trip: String(trip), unit };
    const subject = breakdownSubject(item, clean, { unit, trip });
    await db.update(KEY(site), (cur) => ({ ...(cur || {}), [`email:${emailId}`]: { ...report, subject } }), {});
    await send(report, item, to);
    return { ok: true, subject };
  }

  const keyFor = async (trip) => { const c = await all(); return Object.keys(c).filter((k) => String(c[k].trip) === String(trip) && !c[k].clearedAt).sort((x, y) => c[y].atMs - c[x].atMs)[0] || null; };
  const patch = (k, fields) => db.update(KEY(site), (cur) => ({ ...(cur || {}), [k]: { ...(cur || {})[k], ...fields } }), {});

  // Trucks and trips reported down: team-stop and rolling emails wait until someone says it's fixed or the load moved to another truck.
  const held = async () => Object.values(await all()).filter((r) => !r.clearedAt).flatMap((r) => [String(r.trip), String(r.unit || '').trim().toLowerCase().replace(/^0+(?=\d)/, '')]).filter(Boolean);
  const clear = (trip) => db.update(KEY(site), (cur) => Object.fromEntries(Object.entries(cur || {}).map(([k, r]) => [k, String(r.trip) === String(trip) && !r.clearedAt ? { ...r, clearedAt: now() } : r])), {});

  // Staff say it's fixed: emails turn back on, and the chain hears it.
  async function fixed(trip, by) {
    const k = await keyFor(trip);
    if (!k) return { ok: false, error: `No open breakdown on trip ${trip}.` };
    const r = (await all())[k];
    await patch(k, { clearedAt: now(), fixedBy: by });
    if (r.subject) await sendChain(r, chainEmail(r, 'Breakdown fixed', [`Truck ${r.unit}, trip ${r.trip}.`, `Reported fixed by ${by}.`, 'Team truck alerts are back on for this truck.']));
    return { ok: true };
  }

  // Staff sent the rescue plan: follow it on the same chain.
  async function rescuePlan(trip, { to, by }) {
    const k = await keyFor(trip);
    if (!k) return { ok: false, error: `No open breakdown on trip ${trip}.` };
    const r = (await all())[k];
    if (unitKey(r.rescue && r.rescue.to) === unitKey(to)) return { ok: true, already: true };
    await patch(k, { rescue: { to: String(to), by, at: now() } });
    return { ok: true };
  }

  // after each board refresh: the load on another truck in TruckMate = the transfer is done
  async function process(site0, board) {
    const reports = await all();
    for (const [k, r] of Object.entries(reports)) {
      if (r.clearedAt || !r.unit) continue;
      const item = ((board && board.trips) || []).find((it) => String(((it && it.trip) || {}).tripNumber) === String(r.trip));
      const pu = item && item.trip && item.trip.powerUnit;
      if (!pu || unitKey(pu) === unitKey(r.unit)) continue;
      await patch(k, { clearedAt: now(), transferredTo: String(pu) }); // eslint-disable-line no-await-in-loop
      if (r.subject) await sendChain(r, chainEmail(r, `Transfer completed: truck ${r.unit} to ${pu}`, [`TruckMate shows trip ${r.trip} on truck ${pu}.`, (item.trip.trailer ? `Trailer ${item.trip.trailer}.` : null)])).catch((e) => console.warn('[breakdown-report] transfer:', e.message)); // eslint-disable-line no-await-in-loop
    }
  }

  // on the board: a rescue plan feeds the transfer watch
  async function overlay(site0, trips) {
    const open = Object.values(await all()).filter((r) => !r.clearedAt && r.rescue);
    for (const it of trips) { const r = open.find((x) => String(x.trip) === String(((it && it.trip) || {}).tripNumber)); if (r) it._rescue = { from: r.unit, to: r.rescue.to, subject: r.subject }; }
  }

  if (app) {
    app.get('/br/:token', async (req, res) => {
      const p = readToken(req.params.token, secret, now());
      res.set('Cache-Control', 'no-store').type('html').send(reportPage(p, req.params.token, p ? (await all())[p.a] : null));
    });
    app.post('/br/:token', async (req, res) => {
      const p = readToken(req.params.token, secret, now());
      if (!p) return res.status(403).json({ error: 'This link has expired.' });
      try { const r = await submit(p, req.body || {}); return res.status(r.code).json(r); } catch (e) { console.warn('[breakdown-report]', e.message); return res.status(500).json({ error: 'Could not send. Call dispatch.' }); }
    });
  }
  return { link, forTrip, submit, fromEmail, held, clear, fixed, rescuePlan, process, overlay };
}
