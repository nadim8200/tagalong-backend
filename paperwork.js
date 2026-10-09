// ---------------------------------------------------------------
// Paperwork after delivery.
//  • A load delivers → Jarvis texts the driver (TagAlong app first, else text — consent / STOP
//    rules) for photos of the signed POD and BOL, with the upload link; reminders every 3 h (3 max).
//  • POD + BOL on the load → one email to the broker (rate con contact, its tracking email cc'd)
//    with Billing cc'd: POD, BOL and the rate con attached.
//  • Billing asks Jarvis for a load's POD / BOL / rate con → sent on Billing's own email chain if on
//    file; otherwise Gus + the Dispatch group are asked for what's missing (and the driver is
//    texted), and Billing gets it the moment it's on the load.
// ---------------------------------------------------------------
import { sendMail, mailConfig } from './mailer.js';
import { loadSnapshot } from './updateemail.js';
import { rateConAudience } from './statusmail.js';

const SITE = 'florida-beauty';
const H = 3600000;
const DAY = 24 * H;
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const DONE = /^(delvd|deliv|del$|cmplt|complete)/i;
const first = (n) => String(n || '').trim().split(/\s+/)[0] || '';
export const DOC_LABEL = { pod: 'POD', bol: 'BOL', rate_confirmation: 'rate con' };

// Which kind a stored document is. Pure.
export function docKind(d) {
  const t = `${(d && d.docType) || ''} ${(d && d.kind) || ''}`.toLowerCase();
  if (/proof_of_delivery|\bpod\b/.test(t)) return 'pod';
  if (/bill_of_lading|\bbol\b/.test(t)) return 'bol';
  if (/rate_?con|ratecon|rate_confirmation/.test(t)) return 'rate_confirmation';
  return null;
}
// The newest documents of each kind on a load. Pure. → { pod: [ids], bol: [ids], rate_confirmation: [ids] }
export function onFile(list = []) {
  const out = { pod: [], bol: [], rate_confirmation: [] };
  const sorted = [...list].filter((d) => d && !d.restricted).sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')));
  for (const d of sorted) { const k = docKind(d); if (k && out[k].length < 3) out[k].push(d.id); }
  return out;
}
export const delivered = (item) => DONE.test(String(tripOf(item).status || '')) || loadSnapshot(item).status === 'Delivered';

// The text to the driver. Pure.
export function podText({ name, trip, link, n = 0 }) {
  return `Florida Beauty Flora dispatch: Hi${name ? ` ${first(name)}` : ''}, this is Jarvis (automated).${n ? ` Reminder #${n} —` : ''} load ${trip}: please send photos of the signed POD and BOL.${link ? ` Upload them here: ${link}` : ' Send them in this chat.'} Reply STOP to opt out.`;
}

export function initPaperwork(app, { requireAuth, db, getBoard, docs, driverLinks = null, textDriver = null, groupEmail = null, replyWithDocs = null, env = process.env, fetchFn = globalThis.fetch, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const key = `taPaperwork:${SITE}`;        // trip → { deliveredAt, audience, asks: [at…], sentAt, broker, load }
  const reqKey = `taDocRequests:${SITE}`;   // [{ id, trip, want, emailId, by, at, askedAt, sentAt }]
  const ours = (a) => /@floridabeauty\.us$/i.test(String(a || ''));
  const group = async (n) => (groupEmail ? await groupEmail(n).catch(() => null) : null);
  const listOn = async (trip) => onFile(docs && docs.listDocs ? await docs.listDocs({ site: SITE, trips: [String(trip)] }) : []);

  async function askDriver(item, n) {
    if (!textDriver) return { ok: false };
    const trip = tripNo(item); const s = item._samsara || {};
    const name = (item._oc && item._oc.driverName) || (s.driver1Info && s.driver1Info.name) || s.driver1 || '';
    const link = driverLinks && driverLinks.ensureDocsLink ? await driverLinks.ensureDocsLink(SITE, trip, 'Jarvis (POD / BOL)').catch(() => null) : null;
    try { const r = await textDriver(SITE, trip, podText({ name, trip, link, n }), 'Jarvis (POD / BOL)'); return { ok: !!(r && (r.sent || r.training || /^app/.test(String(r.via || '')))) }; } catch { return { ok: false }; }
  }

  // POD + BOL (+ rate con) → the broker, Billing cc'd. Once per load.
  async function sendToBroker(trip, rec, have) {
    const billing = (await group('billing')) || (await group('accounting'));
    const to = (rec.audience && rec.audience.to) || [];
    const cc = [...new Set([...((rec.audience && rec.audience.cc) || []), ...(billing ? [billing] : [])])];
    if (!mailConfig(env).ready || (!to.length && !billing)) return { sent: false, why: !to.length && !billing ? 'no broker contact on the rate con and no Billing group email' : 'Outlook not connected' };
    const ids = [...have.pod.slice(0, 2), ...have.bol.slice(0, 2), ...have.rate_confirmation.slice(0, 1)];
    const files = docs && docs.readDocs ? await docs.readDocs({ site: SITE, ids }) : [];
    const name = (id, i) => { const k = have.pod.includes(id) ? 'POD' : have.bol.includes(id) ? 'BOL' : 'RateCon'; return `${k}-${trip}-${i + 1}`; };
    const subj = `POD & BOL — ${rec.load ? `Load ${rec.load} · ` : ''}Trip ${trip}`;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1F2937;max-width:600px"><p>Hello,</p><p>Attached are the signed POD and BOL${have.rate_confirmation.length ? ' and the rate confirmation' : ''} for ${rec.load ? `load <b>${rec.load}</b> (` : ''}trip <b>${trip}</b>${rec.load ? ')' : ''}${rec.deliveredAt ? `, delivered ${new Date(rec.deliveredAt).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET` : ''}.</p><p style="font-size:13px;color:#4B5563">Florida Beauty Flora Dispatch</p></div>`;
    await sendMail({ to: to.length ? to : [billing], cc: to.length ? cc : [], subject: subj, html, text: `Attached are the signed POD and BOL${have.rate_confirmation.length ? ' and the rate confirmation' : ''} for ${rec.load ? `load ${rec.load}, ` : ''}trip ${trip}.\n\nFlorida Beauty Flora Dispatch`, attachments: files.map((f, i) => ({ name: `${name(ids[i], i)}.${/pdf/.test(f.mediaType) ? 'pdf' : 'jpg'}`, contentType: f.mediaType, bytes: f.data })) }, { env, fetchFn });
    // the follow-through POD email (if dispatch said YES to it) is the same thing — don't send twice
    await db.update(`taFollow:${SITE}`, (cur) => ({ ...(cur || {}), [trip]: { ...((cur || {})[trip] || {}), podSent: new Date(now()).toISOString() } }), {});
    return { sent: true, to, cc };
  }

  // Billing (or any staff) asks for a load's paperwork. → { sent | asked, missing }
  async function request({ trip, want = ['pod', 'bol', 'rate_confirmation'], emailId, by }) {
    if (!enabled || !trip) return { error: 'no trip' };
    const kinds = want.filter((k) => DOC_LABEL[k]);
    const have = await listOn(trip);
    const missing = kinds.filter((k) => !have[k].length);
    if (!missing.length && replyWithDocs) {
      await replyWithDocs(emailId, { ids: kinds.flatMap((k) => have[k].slice(0, k === 'rate_confirmation' ? 1 : 2)), text: `Here ${kinds.length === 1 ? 'is' : 'are'} the ${kinds.map((k) => DOC_LABEL[k]).join(', ')} for trip ${trip}.` });
      return { sent: true, missing: [] };
    }
    const id = `dr${now().toString(36)}`;
    await db.update(reqKey, (cur) => [{ id, trip: String(trip), want: kinds, emailId, by, at: new Date(now()).toISOString() }, ...(Array.isArray(cur) ? cur : [])].slice(0, 200), []);
    // ask Gus + Dispatch for what's missing
    const to = [...new Set(['gus@floridabeauty.us', await group('dispatch')].filter(ours))];
    if (to.length && mailConfig(env).ready) {
      await sendMail({ to, subject: `Missing ${missing.map((k) => DOC_LABEL[k]).join(' / ')} — Trip ${trip} (Billing asked)`, html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1F2937;max-width:600px"><p>${by || 'Billing'} asked for the ${kinds.map((k) => DOC_LABEL[k]).join(', ')} for <b>trip ${trip}</b>.</p><p><b>Not on file yet:</b> ${missing.map((k) => DOC_LABEL[k]).join(', ')}.</p><p>Please upload ${missing.length === 1 ? 'it' : 'them'} to the load in the console (trip card → documents), or email ${missing.length === 1 ? 'it' : 'them'} to Jarvis with the trip number. Jarvis sends everything to Billing as soon as it's on the load.</p><p style="font-size:13px;color:#4B5563">Jarvis — AI Dispatcher</p></div>`, text: `${by || 'Billing'} asked for the ${kinds.map((k) => DOC_LABEL[k]).join(', ')} for trip ${trip}. Not on file yet: ${missing.map((k) => DOC_LABEL[k]).join(', ')}. Upload to the load in the console or email them to Jarvis with the trip number — Jarvis sends them to Billing as soon as they're on the load.` }, { env, fetchFn });
    }
    // and the driver, when it's the POD / BOL
    if (missing.some((k) => k === 'pod' || k === 'bol')) {
      const item = ((((await getBoard(SITE)) || {}).trips) || []).find((x) => tripNo(x) === String(trip));
      if (item) await askDriver(item, 0);
    }
    return { sent: false, asked: to, missing };
  }

  // One pass: delivered loads → driver asks / broker email; open Billing requests → send when complete.
  async function run() {
    if (!enabled) return [];
    const items = ((await getBoard(SITE)) || {}).trips || [];
    const book = (await db.get(key, {})) || {};
    const adopting = !(await db.get(`${key}:adopted`, null));   // first run: loads already delivered are noted, not chased
    const out = [];
    for (const it of items) {
      const trip = tripNo(it);
      if (!trip || book[trip] || !delivered(it)) continue;
      const rc = (it._ratecon && (it._ratecon.data || it._ratecon)) || {};
      book[trip] = { deliveredAt: new Date(now()).toISOString(), audience: rateConAudience(it), load: rc.loadNumber || null, broker: rc.broker || null, asks: [], ...(adopting ? { sentAt: 'before Jarvis handled paperwork' } : {}) };
    }
    for (const [trip, rec] of Object.entries(book)) {
      if (rec.sentAt || now() - Date.parse(rec.deliveredAt) > 7 * DAY) continue;
      // POD on file but no BOL yet: wait up to 6 h for the BOL, then send what we have
      const have = await listOn(trip); // eslint-disable-line no-await-in-loop
      if (have.pod.length && (have.bol.length || now() - Date.parse(rec.podAt || (rec.podAt = new Date(now()).toISOString())) > 6 * H)) {
        try { const r = await sendToBroker(trip, rec, have); rec.sentAt = new Date(now()).toISOString(); rec.sent = r; out.push({ trip, sent: r.sent }); } catch (e) { rec.error = e.message; } // eslint-disable-line no-await-in-loop
        continue;
      }
      // ask the driver: right away, then every 3 h (3 reminders)
      const last = rec.asks.length ? Date.parse(rec.asks[rec.asks.length - 1]) : 0;
      if (!have.pod.length && rec.asks.length < 4 && now() - last >= (rec.asks.length ? 3 * H : 0)) {
        const item = items.find((x) => tripNo(x) === trip);
        if (item) { await askDriver(item, rec.asks.length); rec.asks.push(new Date(now()).toISOString()); out.push({ trip, asked: rec.asks.length }); } // eslint-disable-line no-await-in-loop
      }
    }
    if (adopting) await db.set(`${key}:adopted`, new Date(now()).toISOString());
    await db.update(key, (cur) => { const a = { ...(cur || {}), ...book }; Object.keys(a).forEach((n) => { if (now() - Date.parse(a[n].deliveredAt) > 14 * DAY) delete a[n]; }); return a; }, {});
    // Billing's open requests
    const reqs = (await db.get(reqKey, [])) || [];
    for (const r of reqs.filter((x) => !x.sentAt && now() - Date.parse(x.at) < 14 * DAY)) {
      const have = await listOn(r.trip); // eslint-disable-line no-await-in-loop
      if (r.want.every((k) => have[k].length) && replyWithDocs) {
        try { await replyWithDocs(r.emailId, { ids: r.want.flatMap((k) => have[k].slice(0, k === 'rate_confirmation' ? 1 : 2)), text: `Here ${r.want.length === 1 ? 'is' : 'are'} the ${r.want.map((k) => DOC_LABEL[k]).join(', ')} for trip ${r.trip} — now on file.` }); r.sentAt = new Date(now()).toISOString(); out.push({ trip: r.trip, billing: true }); } catch (e) { r.error = e.message; } // eslint-disable-line no-await-in-loop
      }
    }
    if (reqs.length) await db.set(reqKey, reqs);
    return out;
  }
  if (enabled && env.NODE_ENV !== 'test') {
    const t = setInterval(() => { run().catch((e) => console.warn('[paperwork]', e.message)); }, 10 * 60000);
    if (t.unref) t.unref();
  }
  return { run, request };
}
