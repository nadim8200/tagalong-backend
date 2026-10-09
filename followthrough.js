// ---------------------------------------------------------------
// Load follow-through — Jarvis keeps each load's paperwork and promises on track.
//
// 1. A rate con lands on a load (upload, trip-sheet packet or email) → the dispatch
//    group gets one email: the broker's special instructions, the agreed extras
//    (detention, lumper…) and the things Jarvis can do itself, numbered:
//      1. email location / ETA updates to the broker every N hours
//      2. email the POD to the broker as soon as the driver sends it
//      3. text the driver the special instructions
//    Reply "YES" (all), "YES 1 3" or "NO" — Jarvis does them and confirms.
// 2. When the load is delivered Jarvis looks for extras to bill — detention (its own
//    arrive/leave records), lumper receipts, TONU / layover / redelivery mentioned in
//    the load's emails and messages — and makes sure the REVISED rate con with them
//    comes in: a to-do on the load, an email to dispatch offering to request it from
//    the broker (reply YES), reminders until a revised rate con for that load arrives.
// 3. Every morning: one follow-through email — open to-dos from the loads' email
//    chains, revised rate cons still missing, broker emails still waiting on us.
// Replies are matched by the [JV-xxxxx] tag in the subject. Only our staff can say YES.
// ---------------------------------------------------------------
import { randomBytes } from 'crypto';
import { isDelivered } from './statusmail.js';

const SITE = 'florida-beauty';
const H = 3600000;
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const okEmail = (e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || ''));
export const TAG = /\[JV-([A-Z0-9]{5,8})\]/i;
const newToken = () => randomBytes(4).toString('hex').toUpperCase().slice(0, 6);

// The broker emails on a rate con, by job. Pure.
export function brokerEmails(rc = {}) {
  const by = (roles) => (rc.contacts || []).filter((c) => c && roles.includes(c.role) && okEmail(c.email)).map((c) => String(c.email).toLowerCase());
  const main = okEmail(rc.brokerEmail) ? [String(rc.brokerEmail).toLowerCase()] : [];
  const pick = (l) => [...new Set(l)].slice(0, 2);
  return { tracking: pick([...by(['tracking', 'dispatch']), ...main, ...by(['broker_rep'])]), billing: pick([...by(['billing']), ...main, ...by(['broker_rep'])]), rep: pick([...main, ...by(['broker_rep', 'dispatch'])]) };
}

// What Jarvis can do itself for this load, numbered. Pure.
export function offersFromRateCon(trip, rc = {}) {
  const instr = (rc.specialInstructions || []).map(String);
  const all = instr.join(' ');
  const em = brokerEmails(rc);
  const out = [];
  if (em.tracking.length && /(check[- ]?calls?|updates?|track|location|status|eta|macropoint|fourkites|trucker tools|p44|project44)/i.test(all)) {
    const m = all.match(/every\s*(\d{1,2})\s*(h|hr|hrs|hour)/i);
    const n = m ? Math.min(12, Math.max(1, Number(m[1]))) : 4;
    out.push({ kind: 'updates', to: em.tracking, everyHours: n, label: `Email location / ETA updates to ${em.tracking.join(', ')} every ${n} hours until delivered` });
  }
  if (em.billing.length) out.push({ kind: 'pod', to: em.billing, label: `Email the POD to ${em.billing.join(', ')} as soon as the driver sends it` });
  if (instr.length) out.push({ kind: 'driver', text: `Load ${trip} special instructions: ${instr.slice(0, 4).join(' · ')}`.slice(0, 450), label: 'Text the driver these special instructions' });
  return out.map((x, i) => ({ n: i + 1, ...x }));
}

// Extras to bill once the load is over, from what we know about it. Pure.
// comms: the load's log entries; tasks: its to-dos; docs: its documents.
export function extrasFor({ comms = [], tasks = [], docs = [], rc = {} } = {}) {
  const out = [];
  for (const c of comms) if (c && c.kind === 'detention' && c.text) out.push({ kind: 'detention', detail: String(c.text).replace(/^Detention record:\s*/i, '') });
  const lumperDocs = docs.filter((d) => /lumper/i.test(`${d.docType || ''} ${d.filename || ''}`));
  if (lumperDocs.length) out.push({ kind: 'lumper', detail: `${lumperDocs.length} lumper receipt${lumperDocs.length === 1 ? '' : 's'} on file` });
  const text = [...comms.map((c) => c && c.text), ...tasks.map((t) => t && `${t.title || ''} ${t.detail || ''}`)].filter(Boolean).join('\n');
  const said = (re, kind, label) => { const m = text.match(re); if (m && !out.some((o) => o.kind === kind)) out.push({ kind, detail: label(m) }); };
  said(/lumper[^\n]{0,60}?\$\s?(\d[\d,.]*)/i, 'lumper', (m) => `lumper $${m[1]} mentioned`);
  said(/\blumper\b/i, 'lumper', () => 'lumper mentioned in the load\'s messages');
  said(/\btonu\b|truck order(ed)? not used/i, 'tonu', () => 'TONU mentioned');
  said(/\blayover\b/i, 'layover', () => 'layover mentioned');
  said(/re-?deliver(y|ed)|re-?consign/i, 'redelivery', () => 'redelivery / reconsignment mentioned');
  said(/driver assist|unload(ing)? fee/i, 'driver_assist', () => 'driver assist / unloading mentioned');
  said(/extra stop|additional stop|stop[- ]off/i, 'extra_stop', () => 'an extra stop mentioned');
  if (out.some((o) => o.kind === 'detention') && rc.detention) out.find((o) => o.kind === 'detention').detail += ` — rate con terms: ${rc.detention}`;
  if (out.some((o) => o.kind === 'lumper') && rc.lumper) out.find((o) => o.kind === 'lumper').detail += ` — rate con terms: ${rc.lumper}`;
  return out;
}

// "YES", "yes 1 and 3", "si", "no" → which numbers (null = declined). Pure.
export function readDecision(text, count) {
  const t = String(text || '').split(/\n\s*(on .{0,80} wrote:|from:|-----original)/i)[0].toLowerCase();
  if (/^\s*(no|nope|cancel|stop|don'?t)\b/.test(t)) return null;
  if (!/\b(yes|yeah|yep|si|sí|ok|okay|go ahead|do it|approved?|please do|correct|confirm(ed)?)\b/.test(t)) return undefined;   // not a decision
  const nums = [...new Set((t.match(/\b\d{1,2}\b/g) || []).map(Number).filter((n) => n >= 1 && n <= count))];
  return nums.length ? nums : Array.from({ length: count }, (_, i) => i + 1);
}

export function initFollowThrough(app, { requireAuth, db, groupEmail = null, sendMail, playbook = null, etaWatch = null, driver = null, docs = null, getBoard = null, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const cfgKey = 'taFollowCfg';
  const key = `taFollow:${SITE}`;              // trip → { rcSentFor, podTo, podSent, closeout }
  const offersKey = `taFollowOffers:${SITE}`;  // [{ token, trip, kind, items, status, … }]
  const DEFAULTS = { to: [], instructions: true, closeout: true, digest: true };
  const settings = async () => {
    const c = { ...DEFAULTS, ...((enabled && (await db.get(cfgKey, {}))) || {}) };
    if (!c.to.length && groupEmail) { const g = await groupEmail('dispatch').catch(() => null); if (g) c.to = [g]; }   // the Dispatch email group
    return c;
  };
  const wrap = (body) => `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.45;color:#1f2937">${body}<p style="color:#6b7280">Jarvis — AI Dispatcher · Florida Beauty Flora</p></div>`;
  const offerBlock = (items, token) => (items.length ? `<p style="margin-top:14px"><b>I can do these for you:</b></p><ol>${items.map((i) => `<li>${esc(i.label)}</li>`).join('')}</ol><p>Reply <b>YES</b> to do all of them, <b>YES 1 3</b> for some, or <b>NO</b>. (Keep [JV-${token}] in the subject.)</p>` : '');

  async function newOffer(trip, kind, items, extra = {}) {
    const token = newToken();
    await db.update(offersKey, (cur) => [{ token, trip, kind, items, status: 'open', at: new Date(now()).toISOString(), ...extra }, ...(Array.isArray(cur) ? cur : [])].slice(0, 400), []);
    return token;
  }

  // 1. a rate con landed on a load
  async function onRateCon(site, trip, rc, prev) {
    if (!enabled) return;
    const cfg = await settings();
    const book = (await db.get(key, {})) || {};
    const f = book[trip] || {};
    // a revised rate con while we're waiting for one → received
    if (prev && f.closeout && ['needed', 'requested'].includes(f.closeout.status)) {
      f.closeout = { ...f.closeout, status: 'received', receivedAt: new Date(now()).toISOString(), oldRate: prev.rate ?? null, newRate: rc.rate ?? null };
      await db.update(key, (cur) => ({ ...(cur || {}), [trip]: f }), {});
      if (cfg.to.length) await sendMail({ to: cfg.to, subject: `✅ Revised rate con received — Trip ${trip}${rc.loadNumber ? ` · Load ${rc.loadNumber}` : ''}`, html: wrap(`<p>The revised rate confirmation for trip <b>${esc(trip)}</b> (${esc(rc.broker || 'broker')}) came in.</p><p>Rate: <b>${esc(prev.rateText || prev.rate || '—')}</b> → <b>${esc(rc.rateText || rc.rate || '—')}</b></p><p>Extras we were billing: ${esc((f.closeout.extras || []).map((x) => x.detail).join('; ') || '—')}</p><p>Accessorials on the new rate con: ${esc((rc.accessorials || []).join('; ') || '—')}</p>`) });
      return;
    }
    const sig = `${rc.loadNumber || ''}|${(rc.specialInstructions || []).join('|')}`;
    if (!cfg.instructions || !cfg.to.length || f.rcSentFor === sig) return;
    const instr = rc.specialInstructions || [];
    const items = offersFromRateCon(trip, rc);
    const token = items.length ? await newOffer(trip, 'ratecon', items) : null;
    const extrasTerms = [rc.detention && `Detention: ${rc.detention}`, rc.lumper && `Lumper: ${rc.lumper}`, ...(rc.accessorials || [])].filter(Boolean);
    await sendMail({ to: cfg.to, subject: `Rate con — Trip ${trip}${rc.broker ? ` · ${rc.broker}` : ''}${rc.loadNumber ? ` ${rc.loadNumber}` : ''} · ${instr.length} special instruction${instr.length === 1 ? '' : 's'}${token ? ` [JV-${token}]` : ''}`,
      html: wrap(`<p>The rate confirmation for <b>trip ${esc(trip)}</b>${rc.broker ? ` (${esc(rc.broker)}${rc.loadNumber ? `, load ${esc(rc.loadNumber)}` : ''})` : ''} is on the load${rc.matchedBy ? ` — matched by ${esc(rc.matchedBy)}` : ''}.</p>
${instr.length ? `<p><b>⚠️ Special instructions from the broker — make sure they're followed:</b></p><ul>${instr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p>No special instructions on this rate con.</p>'}
${extrasTerms.length ? `<p><b>Extras / accessorial terms:</b></p><ul>${extrasTerms.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
${offerBlock(items, token)}`) });
    await db.update(key, (cur) => ({ ...(cur || {}), [trip]: { ...((cur || {})[trip] || {}), rcSentFor: sig } }), {});
  }

  async function brokerOf(site, trip) { return (((await db.get(`taTruckMateRateCon:${site}`, {})) || {})[trip]) || {}; }

  // do the chosen items of an offer
  async function execute(site, offer, nums, by) {
    const results = [];
    const rc = await brokerOf(site, offer.trip);
    for (const it of offer.items.filter((x) => nums.includes(x.n))) {
      try {
        if (it.kind === 'updates' && etaWatch) { const r = await etaWatch.add({ trips: [offer.trip], to: it.to, everyHours: it.everyHours, by, label: `${rc.broker || 'Broker'} updates` }); results.push({ n: it.n, label: it.label, result: r.ok ? 'set up — first one sent now' : r.error }); } // eslint-disable-line no-await-in-loop
        else if (it.kind === 'pod') { await db.update(key, (cur) => ({ ...(cur || {}), [offer.trip]: { ...((cur || {})[offer.trip] || {}), podTo: it.to } }), {}); results.push({ n: it.n, label: it.label, result: 'will send it as soon as the POD is on the load' }); } // eslint-disable-line no-await-in-loop
        else if (it.kind === 'driver' && driver && driver.text) { const r = await driver.text(site, offer.trip, it.text, by); results.push({ n: it.n, label: it.label, result: r && (r.training ? 'held (training mode)' : r.sent || r.via ? 'sent' : r.skipped || 'not sent') }); } // eslint-disable-line no-await-in-loop
        else if (it.kind === 'request_revised') {
          await sendMail({ to: it.to, subject: `Revised rate confirmation — ${rc.loadNumber ? `Load ${rc.loadNumber} · ` : ''}Trip ${offer.trip}`, html: wrap(`<p>Hello,</p><p>Our truck has delivered ${rc.loadNumber ? `load <b>${esc(rc.loadNumber)}</b>` : `trip <b>${esc(offer.trip)}</b>`}. Please send a revised rate confirmation that includes:</p><ul>${(it.extras || []).map((x) => `<li>${esc(x.detail)}</li>`).join('')}</ul><p>Receipts and arrival / departure times are available on request. Thank you.</p>`) }); // eslint-disable-line no-await-in-loop
          await db.update(key, (cur) => { const a = { ...(cur || {}) }; const f = a[offer.trip] || {}; a[offer.trip] = { ...f, closeout: { ...(f.closeout || {}), status: 'requested', requestedAt: new Date(now()).toISOString() } }; return a; }, {}); // eslint-disable-line no-await-in-loop
          results.push({ n: it.n, label: it.label, result: `requested from ${it.to.join(', ')}` });
        } else results.push({ n: it.n, label: it.label, result: 'not available' });
      } catch (e) { results.push({ n: it.n, label: it.label, result: `failed: ${e.message}` }); }
    }
    return results;
  }

  // a staff reply to one of Jarvis' [JV-…] emails
  async function handleReply(site, { subject, text, from }) {
    const m = String(subject || '').match(TAG);
    if (!m || !enabled) return { handled: false };
    const offers = (await db.get(offersKey, [])) || [];
    const offer = offers.find((o) => o.token === m[1].toUpperCase());
    if (!offer) return { handled: false };
    if (offer.status !== 'open') return { handled: true, summary: `Already ${offer.status} (${offer.decidedBy || ''}).` };
    const nums = readDecision(text, offer.items.length);
    if (nums === undefined) return { handled: false };   // not a yes / no — read it like any other email
    const by = `Jarvis (approved by ${from.name || from.address} by email)`;
    const results = nums === null ? [] : await execute(site, offer, nums, by);
    await db.update(offersKey, (cur) => (Array.isArray(cur) ? cur : []).map((o) => (o.token === offer.token ? { ...o, status: nums === null ? 'declined' : 'done', decidedBy: from.name || from.address, decidedAt: new Date(now()).toISOString(), results } : o)), []);
    await sendMail({ to: [from.address], subject: `Re: ${subject}`, html: wrap(nums === null ? '<p>OK — I won\'t do those.</p>' : `<p>Done for trip <b>${esc(offer.trip)}</b>:</p><ul>${results.map((r) => `<li>${esc(r.label)} — <b>${esc(r.result)}</b></li>`).join('')}</ul>`) });
    return { handled: true, summary: nums === null ? `Declined Jarvis' offer for trip ${offer.trip}.` : `Approved: ${results.map((r) => `${r.n}. ${r.result}`).join('; ')}` };
  }

  // 2 + 3. every Watchtower cycle
  async function run(site, items = [], { force = false } = {}) {
    if (!enabled) return;
    const cfg = await settings();
    const t = now();
    const book = (await db.get(key, {})) || {};
    const comms = (await db.get(`taTripComms:${site}`, {})) || {};
    const tasks = (await db.get(`taLoadTasks:${site}`, {})) || {};
    const rcs = (await db.get(`taTruckMateRateCon:${site}`, {})) || {};
    const live = new Map(items.map((it) => [tripNo(it), it]));
    let changed = false;
    for (const [trip, it] of live) {
      const f = book[trip] || {};
      // POD → broker, once it's on the load
      if (f.podTo && !f.podSent && docs && docs.listDocs) {
        const pods = (await docs.listDocs({ site, trips: [trip] })).filter((d) => /proof_of_delivery|pod/i.test(`${d.docType || ''} ${d.kind || ''}`) && !d.restricted); // eslint-disable-line no-await-in-loop
        if (pods.length) {
          const files = docs.readDocs ? await docs.readDocs({ site, ids: pods.slice(0, 3).map((d) => d.id) }) : []; // eslint-disable-line no-await-in-loop
          const rc = rcs[trip] || {};
          try {
            await sendMail({ to: f.podTo, subject: `POD — ${rc.loadNumber ? `Load ${rc.loadNumber} · ` : ''}Trip ${trip}`, html: wrap(`<p>Hello,</p><p>Attached is the proof of delivery for ${rc.loadNumber ? `load <b>${esc(rc.loadNumber)}</b>` : `trip <b>${esc(trip)}</b>`}.</p>`), attachments: files.map((x, i) => ({ name: `POD-${trip}-${i + 1}.${/pdf/.test(x.mediaType) ? 'pdf' : 'jpg'}`, contentType: x.mediaType, bytes: x.data })) }); // eslint-disable-line no-await-in-loop
            book[trip] = { ...f, podSent: new Date(t).toISOString() }; changed = true;
          } catch (e) { console.warn('[follow] POD:', e.message); }
        }
      }
      // delivered → extras to bill? make sure the revised rate con comes in
      if (cfg.closeout && isDelivered(it) && !(book[trip] || {}).closeoutChecked) {
        const rc = rcs[trip] || {};
        const d = docs && docs.listDocs ? await docs.listDocs({ site, trips: [trip] }).catch(() => []) : []; // eslint-disable-line no-await-in-loop
        const extras = extrasFor({ comms: comms[trip] || [], tasks: tasks[trip] || [], docs: d, rc });
        const g = { ...(book[trip] || {}), closeoutChecked: new Date(t).toISOString() };
        if (extras.length) {
          g.closeout = { status: 'needed', extras, at: new Date(t).toISOString(), reminders: 0 };
          await db.update(`taLoadTasks:${site}`, (cur) => { const a = { ...(cur || {}) }; const have = a[trip] || []; const id = `closeout_${trip}`; if (!have.some((x) => x.id === id)) a[trip] = [{ id, at: new Date(t).toISOString(), source: 'jarvis', from: 'Jarvis', kind: 'other', title: `Get the revised rate con with: ${extras.map((x) => x.kind.replace('_', ' ')).join(', ')}`, detail: extras.map((x) => x.detail).join(' · '), urgency: 'normal', due: null, done: null }, ...have]; return a; }, {}); // eslint-disable-line no-await-in-loop
          const to = brokerEmails(rc).billing.length ? brokerEmails(rc).billing : brokerEmails(rc).rep;
          const items2 = to.length ? [{ n: 1, kind: 'request_revised', to, extras, label: `Email ${to.join(', ')} asking for the revised rate con with these extras` }] : [];
          const token = items2.length ? await newOffer(trip, 'closeout', items2) : null; // eslint-disable-line no-await-in-loop
          if (cfg.to.length) await sendMail({ to: cfg.to, subject: `💲 Trip ${trip} delivered — extras to bill, revised rate con needed${token ? ` [JV-${token}]` : ''}`, html: wrap(`<p><b>Trip ${esc(trip)}</b>${rc.broker ? ` (${esc(rc.broker)}${rc.loadNumber ? `, load ${esc(rc.loadNumber)}` : ''})` : ''} is delivered. Before it's closed, the <b>revised rate confirmation</b> must include:</p><ul>${extras.map((x) => `<li>${esc(x.detail)}</li>`).join('')}</ul>${offerBlock(items2, token)}${!items2.length ? '<p>No broker email on the rate con — please request it directly.</p>' : ''}`) }); // eslint-disable-line no-await-in-loop
        }
        book[trip] = g; changed = true;
      }
      // still waiting for the revised rate con → remind every 24 h (3 times)
      const co = (book[trip] || {}).closeout;
      if (co && ['needed', 'requested'].includes(co.status) && (co.reminders || 0) < 3 && t - Date.parse(co.lastReminder || co.at) >= 24 * H && cfg.to.length) {
        await sendMail({ to: cfg.to, subject: `⏰ Still missing: revised rate con — Trip ${trip}`, html: wrap(`<p>Trip <b>${esc(trip)}</b> still has no revised rate confirmation${co.status === 'requested' ? ` (requested ${new Date(co.requestedAt).toLocaleString('en-US', { timeZone: 'America/New_York' })})` : ''}. Extras: ${esc(co.extras.map((x) => x.detail).join('; '))}.</p>`) }); // eslint-disable-line no-await-in-loop
        book[trip] = { ...book[trip], closeout: { ...co, reminders: (co.reminders || 0) + 1, lastReminder: new Date(t).toISOString() } }; changed = true;
      }
    }
    if (changed) await db.update(key, (cur) => ({ ...(cur || {}), ...book }), {});
    // 3. the morning follow-through email (8 AM Eastern)
    const et = new Date(t).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' });
    const day = new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    if (cfg.digest && cfg.to.length && (force || (Number(et) === 8 && (await db.get('taFollowDigestDay', null)) !== day))) {
      await db.set('taFollowDigestDay', day);
      const open = [...live.keys()].map((trip) => ({ trip, list: (tasks[trip] || []).filter((x) => !x.done) })).filter((x) => x.list.length);
      const waitingRc = Object.entries(book).filter(([, f]) => f.closeout && ['needed', 'requested'].includes(f.closeout.status));
      const emails = (((await db.get(`taEmails:${site}`, { list: [] })) || {}).list || []).filter((e) => e.status === 'new' && (e.trips || []).length && !e.auto && t - Date.parse(e.at) > 2 * H).slice(0, 20);
      const routines = playbook ? await playbook.routines() : [];
      if (open.length || waitingRc.length || emails.length || routines.length) {
        await sendMail({ to: cfg.to, subject: `Follow-through — ${day}: ${open.length} load${open.length === 1 ? '' : 's'} with open to-dos, ${waitingRc.length} revised rate con${waitingRc.length === 1 ? '' : 's'} missing, ${emails.length} email${emails.length === 1 ? '' : 's'} waiting`,
          html: wrap(`${waitingRc.length ? `<p><b>💲 Revised rate cons still missing</b></p><ul>${waitingRc.map(([trip, f]) => `<li>Trip ${esc(trip)} — ${esc(f.closeout.extras.map((x) => x.kind.replace('_', ' ')).join(', '))} (${esc(f.closeout.status)})</li>`).join('')}</ul>` : ''}
${emails.length ? `<p><b>📧 Emails about loads still waiting on us (2 h+)</b></p><ul>${emails.map((e) => `<li>Trip ${esc(e.trips.join(', '))} — ${esc(e.from.name || e.from.address)}: ${esc(e.subject)}</li>`).join('')}</ul>` : ''}
${routines.length ? `<p><b>🔁 Routines (what you taught me)</b></p><ul>${routines.map((r) => `<li>${esc(r.title)}${r.schedule ? ` — ${esc(r.schedule)}` : ''}: ${esc(r.do)}</li>`).join('')}</ul>` : ''}
${open.length ? `<p><b>✅ Open to-dos on loads</b></p><ul>${open.map((x) => `<li><b>Trip ${esc(x.trip)}</b>: ${x.list.slice(0, 4).map((y) => esc(y.title)).join(' · ')}${x.list.length > 4 ? ` (+${x.list.length - 4})` : ''}</li>`).join('')}</ul>` : ''}`) });
      }
    }
  }

  app.get('/truckmate/follow', requireAuth, async (req, res) => {
    const book = (await db.get(key, {})) || {};
    const offers = ((await db.get(offersKey, [])) || []).slice(0, 60);
    res.json({ settings: await settings(), offers, closeouts: Object.entries(book).filter(([, f]) => f.closeout).map(([trip, f]) => ({ trip, ...f.closeout })), pods: Object.entries(book).filter(([, f]) => f.podTo).map(([trip, f]) => ({ trip, to: f.podTo, sent: f.podSent || null })) });
  });
  app.put('/truckmate/follow/settings', requireAuth, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const b = req.body || {};
    const to = [...new Set((Array.isArray(b.to) ? b.to : String(b.to || '').split(/[,;\s]+/)).map((x) => String(x).trim().toLowerCase()).filter(okEmail))].slice(0, 10);
    res.json(await db.update(cfgKey, (cur) => ({ ...(cur || {}), to, instructions: b.instructions !== false, closeout: b.closeout !== false, digest: b.digest !== false }), {}));
  });
  // done / not needed for a closeout from the console
  app.post('/truckmate/follow/:trip/closeout', requireAuth, async (req, res) => {
    const status = ['received', 'not_needed'].includes((req.body || {}).status) ? req.body.status : 'received';
    await db.update(key, (cur) => { const a = { ...(cur || {}) }; const f = a[req.params.trip] || {}; if (f.closeout) a[req.params.trip] = { ...f, closeout: { ...f.closeout, status, closedBy: (req.user && (req.user.name || req.user.email)) || 'dispatcher' } }; return a; }, {});
    res.json({ ok: true });
  });

  console.log(`[follow] load follow-through ${enabled ? 'ready' : 'OFF — needs DATABASE_URL'}`);
  return { onRateCon, handleReply, run };
}
