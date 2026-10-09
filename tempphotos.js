// ---------------------------------------------------------------
// Reefer temperature photos for loads we can't track (no live Samsara reefer reading).
// Three times a day (truck's local time: 8:00 AM, 3:00 PM, 9:30 PM) Jarvis asks the driver —
// company or outside carrier — for a photo of the reefer display: TagAlong app (push) when the
// driver has it, else a text with an upload link, else one Jarvis call. Until the photo comes
// in, a reminder every hour (paused while the driver is in the sleeper berth). The photo goes
// to the dispatch email (our staff only — never the broker).
// Only drivers who agreed to dispatch texts/calls (recorded consent); never after STOP.
// ---------------------------------------------------------------
import { sendMail, mailConfig } from './mailer.js';
import { recipientFor } from './comms.js';
import { wallMs, TZ_BY_STATE } from './pickupfollow.js';

const MIN = 60000;
const SITE = 'florida-beauty';
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const last10 = (p) => String(p || '').replace(/\D+/g, '').slice(-10);
const first = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ROLLING = /^(DEPSHIP|ARRCONS|DEPCONS|INTRAN|ENROUTE)/i;
const EASTERN = new Set(['FL', 'GA', 'SC', 'NC', 'VA', 'WV', 'MD', 'DE', 'DC', 'NJ', 'NY', 'PA', 'CT', 'RI', 'MA', 'VT', 'NH', 'ME', 'OH', 'MI', 'IN', 'KY']);
export const SLOTS = [{ id: 'am', hm: '08:00', label: 'morning' }, { id: 'pm', hm: '15:00', label: 'afternoon' }, { id: 'night', hm: '21:30', label: 'night' }];

// Loaded and rolling, and the reefer temp can't be read live. Pure.
export function needsTempPhotos(item) {
  if (!item || !ROLLING.test(String(tripOf(item).status || ''))) return false;
  const s = item._samsara;
  return !s || s.tempF == null || !!s.tempStale;
}

// The truck's local time zone (from where it is now), else Miami time. Pure.
export function truckZone(item) {
  const loc = String(((item && item._samsara) || {}).location || ((item && item._oc) || {}).location || '');
  const m = loc.match(/,\s*([A-Z]{2})\b(?!.*,\s*[A-Z]{2}\b)/);
  const st = m && m[1];
  return (st && (TZ_BY_STATE[st] || (EASTERN.has(st) ? 'America/New_York' : null))) || 'America/New_York';
}

const ymdIn = (ms, tz) => new Date(ms).toLocaleDateString('en-CA', { timeZone: tz });
// The photo window we're in: the latest of today's 8:00 / 15:00 / 21:30 that has started
// (before 8 AM it is still last night's). Pure.
export function currentSlot(now, tz, slots = SLOTS) {
  const today = ymdIn(now, tz);
  const yest = ymdIn(Date.parse(`${today}T12:00:00Z`) - 86400000, 'UTC');
  const cands = [...slots.map((s) => ({ ...s, day: yest })), ...slots.map((s) => ({ ...s, day: today }))]
    .map((s) => ({ ...s, at: wallMs(s.day, +s.hm.slice(0, 2), +s.hm.slice(3, 5), tz), key: `${s.day} ${s.id}` }))
    .filter((s) => s.at <= now);
  return cands[cands.length - 1];
}

// What to do now for one load. st: this load's state; slot: currentSlot(). Pure.
export function decide(st, slot, now, { sleeping = false, everyMin = 60 } = {}) {
  if (!slot) return null;
  const s = st && st.slot === slot.key ? st : null;
  if (s && s.gotAt) return null;
  if (!s || !s.askedAt) return 'ask';
  if (sleeping) return null;
  return now - Date.parse(s.lastAt || s.askedAt) >= everyMin * MIN ? 'remind' : null;
}

const clock = (slot) => { const [h, m] = slot.hm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
export function askText(step, { name, trip, link, slot, tries = 0 }) {
  const hi = `Florida Beauty Flora dispatch: Hi${name ? ` ${first(name)}` : ''}, this is Jarvis (automated).`;
  const how = link ? ` Send it here: ${link}` : ' Send it in this chat.';
  if (step === 'ask') return `${hi} Load ${trip}: please send a photo of the reefer temperature display (${slot.label} check, ${clock(slot)}).${how} Reply STOP to opt out.`;
  return `${hi} Reminder${tries > 1 ? ` #${tries}` : ''} — load ${trip} still needs the ${slot.label} reefer temperature photo.${how} Reply STOP to opt out.`;
}

// The email to dispatch with the photo(s). Pure.
export function photoEmail({ item, slot, at, by, count, via }) {
  const t = tripOf(item); const s = item._samsara || {};
  const driver = (s.driver1Info && s.driver1Info.name) || s.driver1 || (item._oc && item._oc.driverName) || by || 'the driver';
  const tz = truckZone(item);
  const when = new Date(Date.parse(at)).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const subject = `Reefer temp photo — Trip ${tripNo(item)} · truck ${t.powerUnit || '—'} · trailer ${t.trailer || '—'}${slot ? ` · ${slot.label} check` : ''}`;
  const rows = [['Trip', tripNo(item)], ['Truck / trailer', `${t.powerUnit || '—'} / ${t.trailer || '—'}`], ['Driver', driver], ['Received', `${when} (${via})`], ['Check', slot ? `${slot.label} (${clock(slot)} local)` : 'sent by the driver'], ['Photos', `${count} attached`], ['Live reefer reading', 'not available for this trailer — that is why we ask for photos']];
  const F = 'font-family:Arial,Helvetica,sans-serif';
  const html = `<div style="margin:0;padding:0;background:#F3F4F6" bgcolor="#F3F4F6"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" align="center" style="max-width:600px;margin:0 auto;background:#FFFFFF" bgcolor="#FFFFFF">
<tr><td style="padding:20px 20px 8px 20px;${F};font-size:20px;font-weight:bold;color:#1E3A5F">Reefer temperature photo</td></tr>
${rows.map(([k, v]) => `<tr><td style="padding:4px 20px 0 20px;${F};font-size:13px;color:#4B5563">${esc(k)}</td></tr><tr><td style="padding:0 20px 2px 20px;${F};font-size:16px;line-height:1.5;color:#111827">${esc(v)}</td></tr>`).join('')}
<tr><td style="padding:12px 20px 20px 20px;${F};font-size:13px;color:#4B5563;border-top:1px solid #E5E7EB">Check the display against the load's required temperature. Jarvis — AI Dispatcher · Florida Beauty Flora</td></tr></table></div>`;
  const text = `REEFER TEMPERATURE PHOTO\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nJarvis — AI Dispatcher · Florida Beauty Flora`;
  return { subject, html, text };
}

export function initTempPhotos(app, { requireAuth, requireAdmin = null, groupEmail = null, db, getBoard, docs = null, driverLinks = null, ringcentral = null, voice = null, comms = null, isInternal = () => true, env = process.env, fetchFn = globalThis.fetch, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const key = `taTempPhotos:${SITE}`;
  const cfgKey = 'taTempPhotosCfg';
  const DEFAULTS = { on: true, to: [], everyMin: 60, pauseWhileSleeping: true };
  const settings = async () => ({ ...DEFAULTS, ...((enabled && (await db.get(cfgKey, {}))) || {}) });
  // dispatch email: its own list, else the follow-through dispatch group — our staff only
  const dispatchTo = async () => { const c = await settings(); let list = c.to.length ? c.to : (((await db.get('taFollowCfg', {})) || {}).to || []); if (!list.length && groupEmail) list = [await groupEmail('dispatch').catch(() => null)].filter(Boolean); return list.filter((a) => isInternal(a, env)); };
  const smsLive = async () => { try { const c = ringcentral && ringcentral.configFor ? await ringcentral.configFor('__shared') : null; return !!(c && c.fromNumber); } catch { return false; } };

  async function contact(item, step, slot, st) {
    const trip = tripNo(item);
    const by = 'Jarvis (reefer temp photos)';
    // TagAlong app (outside carriers with the tracking link): push + chat, photos straight back
    if (item._oc && driverLinks && driverLinks.messageDriver) {
      const r = await driverLinks.messageDriver(SITE, trip, askText(step, { name: item._oc.driverName, trip, slot, tries: (st && st.tries) || 0 }).replace(/ Reply STOP to opt out\.$/, ''), by).catch(() => null);
      if (r && r.sent) return { via: r.via || 'app' };
    }
    const rcpt = recipientFor(item, 1, await db.get(`taSmsConsent:${SITE}`, {}));
    if (!rcpt || !rcpt.phone || !rcpt.consent) return { skipped: 'no consent / phone on file' };
    if ((await db.get('taSmsOptOut', {}))[last10(rcpt.phone)]) return { skipped: 'driver replied STOP' };
    if (await smsLive()) {
      const base = driverLinks && driverLinks.ensureDocsLink ? await driverLinks.ensureDocsLink(SITE, trip, by).catch(() => null) : null;
      const link = base ? `${base}${base.includes('?') ? '&' : '?'}photo=temp` : null;
      const text = askText(step, { name: rcpt.name, trip, link, slot, tries: (st && st.tries) || 0 });
      await ringcentral.sendSms('__shared', { to: rcpt.phone, text });
      if (comms && comms.log) await comms.log(SITE, trip, { type: 'text', kind: `temp-photo-${step}`, to: rcpt.phone, text, by });
      return { via: 'text' };
    }
    // no texting yet: one Jarvis call per check (it asks for the reading and the photo)
    if (step === 'ask' && voice && voice.placeCall) {
      await voice.placeCall(trip, { purpose: 'temp-photo', by, vars: { check: `${slot.label} (${clock(slot)})` } });
      return { via: 'call' };
    }
    return { skipped: 'texting not live yet' };
  }

  // One pass over the board.
  async function run() {
    const cfg = await settings();
    if (!enabled || !cfg.on) return [];
    const items = ((await getBoard(SITE)) || {}).trips || [];
    const book = (await db.get(key, {})) || {};
    const out = [];
    for (const it of items) {
      const trip = tripNo(it);
      if (!trip || !needsTempPhotos(it)) continue;
      const slot = currentSlot(now(), truckZone(it));
      const prev = book[trip] || {};
      let st = prev.slot === slot.key ? prev : { slot: slot.key, slotAt: new Date(slot.at).toISOString(), tries: 0, history: [...(prev.history || []), ...(prev.slot ? [{ slot: prev.slot, gotAt: prev.gotAt || null, missed: !prev.gotAt, tries: prev.tries || 0 }] : [])].slice(-12) };
      const hos = ((it._samsara || {}).hos || {}).status;
      const step = decide(st, slot, now(), { sleeping: cfg.pauseWhileSleeping && /sleeper/i.test(String(hos || '')), everyMin: cfg.everyMin });
      if (step) {
        try {
          const r = await contact(it, step, slot, st); // eslint-disable-line no-await-in-loop
          const at = new Date(now()).toISOString();
          st = { ...st, askedAt: st.askedAt || at, lastAt: at, tries: (st.tries || 0) + (r.via ? 1 : 0), last: r };
          out.push({ trip, step, ...r });
        } catch (e) { st = { ...st, lastAt: new Date(now()).toISOString(), last: { error: e.message } }; }
      }
      book[trip] = st;
    }
    await db.update(key, (cur) => { const a = { ...(cur || {}), ...book }; const live = new Set(items.map(tripNo)); Object.keys(a).forEach((n) => { if (!live.has(n)) delete a[n]; }); return a; }, {});
    return out;
  }

  // A photo came in from the driver (upload link "reefer temp", or a photo in the app chat
  // while a temp check is open) → mark the check done and email dispatch.
  async function received(site, trip, { docIds = [], via = 'driver', by = null, forced = false } = {}) {
    if (!enabled || !docIds.length) return { counted: false };
    let slotKey = null; let counted = false;
    await db.update(key, (cur) => {
      const a = { ...(cur || {}) }; const st = a[trip];
      if (!st && !forced) return a;
      if (st && (st.askedAt || forced) && !st.gotAt) { a[trip] = { ...st, gotAt: new Date(now()).toISOString(), docIds, via }; slotKey = st.slot; counted = true; } else if (forced) counted = true;
      return a;
    }, {});
    if (!counted) return { counted: false };
    if (docs && docs.markDocs) await docs.markDocs({ site, ids: docIds, docType: 'reefer_temp' }).catch(() => {});
    const to = await dispatchTo();
    if (!to.length || !mailConfig(env).ready) return { counted: true, emailed: false };
    const item = (((await getBoard(site)) || {}).trips || []).find((x) => tripNo(x) === String(trip)) || { trip: { tripNumber: String(trip) } };
    const slot = slotKey ? SLOTS.find((s) => slotKey.endsWith(` ${s.id}`)) : null;
    const m = photoEmail({ item, slot, at: new Date(now()).toISOString(), by, count: docIds.length, via });
    const files = docs && docs.readDocs ? await docs.readDocs({ site, ids: docIds.slice(0, 6) }) : [];
    await sendMail({ to, subject: m.subject, html: m.html, text: m.text, attachments: files.map((f, i) => ({ name: `reefer-temp-${trip}-${i + 1}.${/pdf/.test(f.mediaType) ? 'pdf' : 'jpg'}`, contentType: f.mediaType, bytes: f.data })) }, { env, fetchFn });
    return { counted: true, emailed: true };
  }

  if (enabled && env.TEMP_PHOTOS !== 'off' && env.NODE_ENV !== 'test') {
    const t = setInterval(() => { run().catch((e) => console.warn('[temp-photos]', e.message)); }, 5 * MIN);
    if (t.unref) t.unref();
  }

  // board overlay: where the photo checks stand
  async function overlay(s, trips) {
    if (!enabled) return;
    const book = (await db.get(key, {})) || {};
    for (const it of trips) { const st = book[tripNo(it)]; if (st) it._tempPhotos = { slot: st.slot, asked: !!st.askedAt, got: !!st.gotAt, tries: st.tries || 0, missed: (st.history || []).filter((h) => h.missed).length }; }
  }
  const admin = requireAdmin || requireAuth;
  app.get('/truckmate/temp-photos/settings', requireAuth, async (req, res) => res.json({ ...(await settings()), dispatchTo: await dispatchTo() }));
  app.put('/truckmate/temp-photos/settings', admin, async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Needs the database.' });
    const b = req.body || {};
    const to = [...new Set(String(Array.isArray(b.to) ? b.to.join(',') : b.to || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))].filter((a) => isInternal(a, env)).slice(0, 20);
    res.json(await db.update(cfgKey, (cur) => ({ ...(cur || {}), to, on: b.on !== false, pauseWhileSleeping: b.pauseWhileSleeping !== false, everyMin: Math.min(240, Math.max(30, Number(b.everyMin) || 60)) }), {}));
  });
  console.log(`[temp-photos] reefer temp photo checks ${enabled ? 'ready' : 'OFF — needs DATABASE_URL'}`);
  return { run, received, overlay };
}
