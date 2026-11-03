// ---------------------------------------------------------------
// Driver profiles. A company driver signs in with what dispatch already has on file: their driver ID and their cell. The roster is
// Samsara's drivers (their username is the TruckMate driver ID, like 0986). They stay signed in until they sign out; a driver who leaves
// the roster, or whose cell changes, is out on the next request. Signed in, a driver sees their current and next loads, sends paperwork and
// messages dispatch on each load (through the load's own driver link), and sees what they sent. Outside carriers keep the load link they get by text.
// A 4-digit PIN goes with the ID and cell: the driver makes it at the first sign-in. Only admins (not regular dispatch) can see it, give a new
// one, or clear it so the driver makes a new one. A new PIN signs the driver out everywhere. It's kept encrypted, so an admin can read it out.
// ---------------------------------------------------------------
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto';

const SITE = 'florida-beauty';
const PINS = `taDriverPins:${SITE}`;        // driver ID → { enc, setAt, by }
const MIN = 60000;
const MAX_TRIES = 10;               // wrong sign-ins per phone, or per connection, in 15 minutes
const SESSION = '3650d';            // until they sign out
const ROLLING = /^(DEPSHIP|ARRCONS|DEPCONS|INTRAN|ENROUTE|ARRSHIP|LOADED|SPOT)/i;
const BOOKED = /^(DISP|ASSGN|AVAIL|PLAN|PEND|BOOK)/i;
const DONE = /^(delvd|deliv|del$|cmplt|complete|canc|void)/i;
const last10 = (p) => { const d = String(p || '').replace(/\D+/g, ''); return d.length >= 10 ? d.slice(-10) : null; };
const norm = (x) => String(x || '').trim().toUpperCase().replace(/^0+(?=\d)/, '');
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
// A PIN a driver can't guess easily: 4 digits, not all the same, not counting up or down. Pure. → error text or null
export function pinProblem(pin) {
  const p = String(pin || '');
  if (!/^\d{4}$/.test(p)) return 'The PIN is 4 numbers.';
  if (/^(\d)\1{3}$/.test(p) || '0123456789'.includes(p) || '9876543210'.includes(p)) return 'Pick a PIN that is harder to guess.';
  return null;
}
const keyOf = (secret) => createHash('sha256').update(`${secret}:driver-pins`).digest();
export const sealPin = (pin, secret) => { const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', keyOf(secret), iv); const data = Buffer.concat([c.update(String(pin), 'utf8'), c.final()]); return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${data.toString('base64')}`; };
export const openPin = (enc, secret) => { const [iv, tag, data] = String(enc || '').split('.').map((x) => Buffer.from(x, 'base64')); const d = createDecipheriv('aes-256-gcm', keyOf(secret), iv); d.setAuthTag(tag); return Buffer.concat([d.update(data), d.final()]).toString('utf8'); };
const billsOf = (it) => (it && (it.freightBills || it.orders)) || tripOf(it).freightBills || [];

// The driver's loads on the board by their TruckMate driver ID: rolling now, then booked next. Pure.
export function loadsFor(code, items = []) {
  const mine = items.filter((it) => [tripOf(it).driver, tripOf(it).driver2].some((c) => c && norm(c) === norm(code)) && !DONE.test(String(tripOf(it).status || '')));
  const brief = (it) => { const t = tripOf(it); return { trip: tripNo(it), status: t.status || null, truck: t.powerUnit || null, trailer: t.trailer || null, from: t.origZoneDesc || null, to: t.destZoneDesc || null, stops: billsOf(it).slice(0, 20).map((b) => ({ bill: b.billNumber || null, to: b.endZoneDescription || null, customer: b.billToName || null, deliverBy: b.deliverBy || null, pieces: b.pieces != null ? Number(b.pieces) : null, delivered: !!b.actualDelivery })) }; };
  return { current: mine.filter((it) => ROLLING.test(String(tripOf(it).status || ''))).map(brief), next: mine.filter((it) => BOOKED.test(String(tripOf(it).status || ''))).map(brief) };
}

export function initDriverAuth(app, { requireAuth, requireAdmin = null, db, sign, secret, roster, getBoard, docsLink = null, sheets = null, stopFlow = null, push = null, training = null, unreadFor = null, now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const PUSH = `taDriverPush:${SITE}`;            // driver ID → [{ token, platform, env, at }] (the phones signed in to the profile)
  const NOTIFIED = `taDriverNotified:${SITE}`;    // driver ID → trips they were told about
  const tripsKey = (code) => `taDriverTrips:${SITE}:${norm(code)}`;
  const byCode = async (code) => (await roster()).find((d) => norm(d.code) === norm(code)) || null;
  const misses = new Map();   // phone or connection → wrong tries in the last 15 minutes
  const tooMany = (k) => (misses.get(k) || []).filter((t) => now() - t < 15 * MIN).length >= MAX_TRIES;
  const miss = (k) => misses.set(k, [...(misses.get(k) || []).filter((t) => now() - t < 15 * MIN), now()]);

  const pins = async () => (await db.get(PINS, {})) || {};
  const setPin = (code, pin, by) => db.update(PINS, (cur) => ({ ...(cur || {}), [norm(code)]: { enc: sealPin(pin, secret), setAt: now(), by } }), {});

  app.post('/driver/auth/login', async (req, res) => {
    if (!enabled) return res.status(503).json({ error: 'Not available right now.' });
    const b = req.body || {};
    const id = String(b.driverId || '').trim(); const p = last10(b.phone);
    if (!id || !p) return res.status(400).json({ error: 'Enter your driver ID and your 10-digit cell number.' });
    const ip = String(req.ip || 'unknown');
    if (tooMany(p) || tooMany(ip)) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes or call dispatch.' });
    try {
      const d = await byCode(id);
      if (!d || last10(d.phone) !== p) { miss(p); miss(ip); return res.status(401).json({ error: 'That driver ID and cell don\'t match what dispatch has. Call dispatch.' }); }
      const have = (await pins())[norm(d.code)];
      if (!have) {
        // first sign-in, or an admin cleared the PIN: the driver makes one now
        if (b.newPin == null) return res.status(428).json({ createPin: true, error: 'Make a 4-digit PIN. You will use it every time you sign in.' });
        const bad = pinProblem(b.newPin); if (bad) return res.status(400).json({ error: bad });
        await setPin(d.code, String(b.newPin), d.name);
      } else if (openPin(have.enc, secret) !== String(b.pin || '')) { miss(p); miss(ip); return res.status(401).json({ error: b.pin ? 'That PIN is not right. If you forgot it, call dispatch: an admin can tell you or give you a new one.' : 'Enter your PIN.' }); }
      const fresh = (await pins())[norm(d.code)];
      const user = { role: 'driver', driverCode: norm(d.code), name: d.name, phone: p, pinAt: fresh.setAt };
      return res.json({ token: sign(user, SESSION), name: d.name });
    } catch { return res.status(503).json({ error: 'Could not check. Try again.' }); }
  });

  // a signed-in driver who is still on the roster
  const requireDriver = (req, res, next) => requireAuth(req, res, async () => {
    if (!req.user || req.user.role !== 'driver') return res.status(403).json({ error: 'Driver sign-in only.' });
    try {
      const d = await byCode(req.user.driverCode);
      const pin = (await pins())[norm(req.user.driverCode)];
      if (!d || last10(d.phone) !== req.user.phone || !pin || pin.setAt !== req.user.pinAt) return res.status(401).json({ error: 'Sign in again.' });
      req.driver = d; return next();
    } catch { return res.status(503).json({ error: 'Could not check your profile. Try again.' }); }
  });
  const board = async () => (((await getBoard(SITE)) || {}).trips || []);

  app.get('/driver/me', requireDriver, async (req, res) => {
    try {
      const loads = loadsFor(req.driver.code, await board());
      const trips = [...loads.current, ...loads.next].map((l) => l.trip);
      // the load message dispatch sent (names, addresses, PU#, times, notes): what TruckMate doesn't have
      const items0 = await board();
      // no message from dispatch yet: the rate con on the load fills it in (loadsheet.js)
      if (sheets && sheets.ensureFromRateCon) for (const l of [...loads.current, ...loads.next]) await sheets.ensureFromRateCon(items0.find((it) => tripNo(it) === l.trip)).catch(() => null); // eslint-disable-line no-await-in-loop
      if (sheets) for (const l of [...loads.current, ...loads.next]) l.sheet = await sheets.forDriver(await sheets.get(l.trip)); // eslint-disable-line no-await-in-loop
      // dispatch messages the driver hasn't opened yet, per load (the Chats tab shows them)
      if (unreadFor) for (const l of [...loads.current, ...loads.next]) l.unread = await unreadFor(SITE, l.trip).catch(() => 0); // eslint-disable-line no-await-in-loop
      // an LTL load: the trip sheet's stops, each marked done with boxes and signed paperwork (stopflow.js)
      if (stopFlow) { const items = await board(); for (const l of [...loads.current, ...loads.next]) l.ltl = await stopFlow.forDriver(items.find((it) => tripNo(it) === l.trip)); } // eslint-disable-line no-await-in-loop
      if (trips.length) await db.update(tripsKey(req.driver.code), (cur) => [...new Set([...trips, ...(Array.isArray(cur) ? cur : [])])].slice(0, 300), []);
      res.json({ name: req.driver.name, driverId: req.driver.code, ...loads });
    } catch (e) { res.status(502).json({ error: 'Could not load your loads. Try again.' }); }
  });
  // a load's own driver page (paperwork, messages): only for a load that's theirs
  app.post('/driver/me/loads/:trip/link', requireDriver, async (req, res) => {
    const trip = String(req.params.trip);
    const loads = loadsFor(req.driver.code, await board());
    if (![...loads.current, ...loads.next].some((l) => l.trip === trip)) return res.status(404).json({ error: 'That load is not yours.' });
    if (!docsLink) return res.status(503).json({ error: 'Not available right now.' });
    const url = await docsLink(SITE, trip, `${req.driver.name} (driver profile)`);
    return url ? res.json({ token: url.split('/t/')[1] }) : res.status(503).json({ error: 'Not available right now.' });
  });
  // the driver got the load info: "OK" (instead of texting it back)
  app.post('/driver/me/loads/:trip/ok', requireDriver, async (req, res) => {
    const trip = String(req.params.trip);
    const loads = loadsFor(req.driver.code, await board());
    if (![...loads.current, ...loads.next].some((l) => l.trip === trip)) return res.status(404).json({ error: 'That load is not yours.' });
    const s = sheets ? await sheets.confirm(trip, req.driver.name) : null;
    return s ? res.json({ ok: true, confirmedAt: s.confirmedAt }) : res.status(404).json({ error: 'Dispatch hasn\'t sent the load info yet.' });
  });
  // the driver dropped the trailer at the yard dispatch released them to: the team gets an email (and the trailer they picked up, if any)
  app.post('/driver/me/loads/:trip/dropped', requireDriver, async (req, res) => {
    const trip = String(req.params.trip);
    const loads = loadsFor(req.driver.code, await board());
    const l = [...loads.current, ...loads.next].find((x) => x.trip === trip);
    if (!l) return res.status(404).json({ error: 'That load is not yours.' });
    try {
      const d = sheets ? await sheets.dropped(trip, req.driver.name, { pickedUp: (req.body || {}).pickedUp, truck: l.truck, trailer: l.trailer }) : null;
      return d ? res.json({ ok: true, dropped: d }) : res.status(404).json({ error: 'Dispatch hasn\'t set a yard for this load.' });
    } catch (e) { return res.status(502).json({ error: 'Could not send. Call dispatch.' }); }
  });
  // LTL stop by stop: done (boxes + signed paperwork), an issue (with photos), and the load completed at the last stop
  const mine = async (req, res) => { const trip = String(req.params.trip); const loads = loadsFor(req.driver.code, await board()); if (![...loads.current, ...loads.next].some((l) => l.trip === trip)) { res.status(404).json({ error: 'That load is not yours.' }); return null; } if (!stopFlow) { res.status(503).json({ error: 'Not available right now.' }); return null; } return trip; };
  const answer = (res, r) => (r.error ? res.status(r.code || 400).json({ error: r.error }) : res.json(r));
  const files = (b) => (Array.isArray(b.files) ? b.files : []).filter((f) => f && f.dataBase64).slice(0, 30);
  app.post('/driver/me/loads/:trip/stops/:n/done', requireDriver, async (req, res) => {
    const trip = await mine(req, res); if (!trip) return null;
    const b = req.body || {};
    try { return answer(res, await stopFlow.stopDone(trip, req.params.n, { boxes: b.boxes, files: files(b), scan: b.scan !== false, by: req.driver.name })); } catch (e) { return res.status(400).json({ error: e.message || 'Could not save.' }); }
  });
  app.post('/driver/me/loads/:trip/stops/:n/issue', requireDriver, async (req, res) => {
    const trip = await mine(req, res); if (!trip) return null;
    const b = req.body || {};
    try { return answer(res, await stopFlow.stopIssue(trip, req.params.n, { text: b.text, files: files(b), by: req.driver.name })); } catch (e) { return res.status(400).json({ error: e.message || 'Could not send.' }); }
  });
  app.post('/driver/me/loads/:trip/complete', requireDriver, async (req, res) => {
    const trip = await mine(req, res); if (!trip) return null;
    try { return answer(res, await stopFlow.complete(trip, { by: req.driver.name })); } catch (e) { return res.status(400).json({ error: e.message || 'Could not complete.' }); }
  });
  // this phone gets notifications: a new load, a message from dispatch
  app.post('/driver/me/push', requireDriver, async (req, res) => {
    const b = req.body || {}; const t = String(b.token || '').trim();
    if (t.length < 32 || t.length > 400) return res.status(400).json({ error: 'Bad push token.' });
    const rec = { token: t, platform: ['ios', 'android'].includes(b.platform) ? b.platform : 'ios', env: b.env === 'development' ? 'development' : 'production', at: new Date(now()).toISOString() };
    await db.update(PUSH, (cur) => ({ ...(cur || {}), [norm(req.driver.code)]: [...((cur || {})[norm(req.driver.code)] || []).filter((x) => x.token !== t), rec].slice(-3) }), {});
    return res.json({ ok: true });
  });
  app.get('/driver/me/paperwork', requireDriver, async (req, res) => {
    const mine = new Set((await db.get(tripsKey(req.driver.code), [])) || []);
    const list = ((await db.get(`taDriverPaperwork:${SITE}`, [])) || []).filter((p) => mine.has(String(p.trip))).slice(0, 100).map(({ docIds, ...p }) => p);
    res.json({ paperwork: list });
  });
  // the driver changes their own PIN (signed in, with the current one): other phones are signed out
  app.post('/driver/me/pin', requireDriver, async (req, res) => {
    const b = req.body || {};
    const have = (await pins())[norm(req.driver.code)];
    if (!have || openPin(have.enc, secret) !== String(b.current || '')) return res.status(401).json({ error: 'Your current PIN is not right.' });
    const bad = pinProblem(b.next); if (bad) return res.status(400).json({ error: bad });
    await setPin(req.driver.code, String(b.next), req.driver.name);
    const fresh = (await pins())[norm(req.driver.code)];
    const { iat, exp, ...user } = req.user;   // eslint-disable-line no-unused-vars
    return res.json({ ok: true, token: sign({ ...user, pinAt: fresh.setAt }, SESSION) });
  });

  // admins only (platform and company admins, never regular dispatch): see a forgotten PIN, give a new one, or clear it
  if (requireAdmin) {
    const who = (req) => (req.user && (req.user.name || req.user.email)) || 'admin';
    app.get('/admin/driver-pins', requireAdmin, async (req, res) => {
      const all = await pins();
      res.json({ drivers: (await roster()).map((d) => ({ driverId: d.code, name: d.name, cell: last10(d.phone) ? `•••${last10(d.phone).slice(-4)}` : null, hasPin: !!all[norm(d.code)], pinSetAt: all[norm(d.code)] ? new Date(all[norm(d.code)].setAt).toISOString() : null, pinSetBy: all[norm(d.code)] ? all[norm(d.code)].by : null })).sort((a, b) => String(a.name).localeCompare(String(b.name))) });
    });
    app.post('/admin/driver-pins/:id/show', requireAdmin, async (req, res) => {
      const have = (await pins())[norm(req.params.id)];
      if (!have) return res.status(404).json({ error: 'This driver has no PIN yet. They make one when they sign in.' });
      req.body = { driver: norm(req.params.id) };   // the activity log records who looked
      return res.json({ pin: openPin(have.enc, secret) });
    });
    app.post('/admin/driver-pins/:id/new', requireAdmin, async (req, res) => {
      const d = await byCode(req.params.id);
      if (!d) return res.status(404).json({ error: 'Not on the driver list.' });
      let pin; do { pin = String(randomInt(0, 10000)).padStart(4, '0'); } while (pinProblem(pin));
      await setPin(d.code, pin, who(req));
      req.body = { driver: norm(d.code) };
      return res.json({ pin });
    });
    app.post('/admin/driver-pins/:id/clear', requireAdmin, async (req, res) => {
      await db.update(PINS, (cur) => { const all = { ...(cur || {}) }; delete all[norm(req.params.id)]; return all; }, {});
      req.body = { driver: norm(req.params.id) };
      return res.json({ ok: true });
    });
  }
  // a notification to a driver's phones (training mode holds it, like every app message)
  async function notify(code, { title, body, data = {} }) {
    if (!push || !enabled) return { skipped: 'push not set up' };
    const tokens = ((await db.get(PUSH, {})) || {})[norm(code)] || [];
    if (!tokens.length) return { skipped: 'no phone signed in' };
    if (training) { const held = await training.hold('app', { to: `driver ${code}`, text: `${title}: ${body}` }); if (held) return { held: true }; }
    const dead = await push.sendToTokens(tokens, { title, body, data: { ...data, path: `/driver${data.tab ? `?tab=${data.tab}` : ''}` } });
    if (dead.length) await db.update(PUSH, (cur) => ({ ...(cur || {}), [norm(code)]: ((cur || {})[norm(code)] || []).filter((x) => !dead.includes(x.token)) }), {});
    return { sent: tokens.length - dead.length };
  }
  // dispatch (or Jarvis) wrote to the driver on a load: both drivers of the load hear it
  async function notifyTrip(trip, text, by = 'Dispatch') {
    const it = (await board()).find((x) => tripNo(x) === String(trip));
    const t = tripOf(it);
    const codes = [t.driver, t.driver2].filter(Boolean);
    for (const c of codes) await notify(c, { title: `${by.replace(/ \(.*\)$/, '')} · trip ${trip}`, body: String(text || '').slice(0, 180), data: { tab: 'chat', trip: String(trip) } }); // eslint-disable-line no-await-in-loop
  }
  // every board run: a load that shows up for a driver with the app → "New load assigned" once. A driver's first run only learns
  // what they already have (no burst of old loads).
  async function processAssignments(items = null) {
    if (!enabled || !push) return;
    const phones = (await db.get(PUSH, {})) || {};
    const codes = Object.keys(phones).filter((c) => (phones[c] || []).length);
    if (!codes.length) return;
    const all = items || await board();
    const told = (await db.get(NOTIFIED, {})) || {};
    for (const code of codes) {
      const l = loadsFor(code, all);
      const trips = [...l.current, ...l.next];
      const before = told[code];
      const fresh = before ? trips.filter((x) => !before.includes(x.trip)) : [];
      for (const x of fresh) await notify(code, { title: 'New load assigned', body: `Trip ${x.trip}${x.from || x.to ? ` · ${x.from || '?'} → ${x.to || '?'}` : ''}`, data: { tab: l.current.some((c) => c.trip === x.trip) ? 'now' : 'next', trip: x.trip } }); // eslint-disable-line no-await-in-loop
      if (!before || fresh.length) await db.update(NOTIFIED, (cur) => ({ ...(cur || {}), [code]: [...new Set([...trips.map((x) => x.trip), ...((cur || {})[code] || [])])].slice(0, 300) }), {}); // eslint-disable-line no-await-in-loop
    }
  }
  return { requireDriver, notify, notifyTrip, processAssignments };
}
