// ---------------------------------------------------------------
// Waiting time at a shipper or receiver, on broker loads only: LTL stops from the hubs don't get it. TruckMate marks the truck there; the clock starts 3 hours after the appointment, or 3 hours
// after arrival if the truck got there later, so a truck that came early doesn't count its early hours. When the clock is due, dispatch
// gets an email and approves it or not. When the truck leaves, approved or unanswered clocks get a total. Internal only: nothing here
// reaches a customer, a broker or a driver, and it is never a bill by itself.
// ---------------------------------------------------------------
import { makeToken, readToken, page, loadRows } from './breakdownreport.js';
import { brokerLoad } from './watchtower.js';

const KEY = (site) => `taWaiting:${site}`;
const SITE = 'florida-beauty';
const FREE_MS = 3 * 3600000;
const STALE_MS = 24 * 3600000;      // a status left on "arrived" for a day says nothing about waiting now
const KEEP_DAYS = 30;
const PURPOSE = 'waiting-time';
const AT_STOP = { ARRSHIP: 'shipper', ARRCONS: 'receiver' };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const oneLine = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const tripNo = (it) => String(((it && it.trip) || {}).tripNumber || '');

// When the clock starts. Pure.
export const clockStart = (arrivedMs, apptMs = null) => Math.max(arrivedMs, apptMs || 0) + FREE_MS;

// Where TruckMate says the truck is: the last status, when it's an arrival. Pure.
export function atStop(item) {
  const h = (item && item._times && item._times.statusHistory) || [];
  const last = h[h.length - 1];
  const kind = last && AT_STOP[String(last.status).toUpperCase()];
  return kind ? { kind, arrivedMs: Date.parse(last.at) } : null;
}
// When TruckMate says it left, after arriving. Pure.
export function leftAt(item, arrivedMs) {
  const next = ((item && item._times && item._times.statusHistory) || []).find((x) => Date.parse(x.at) > arrivedMs && /^DEP/i.test(x.status));
  return next ? Date.parse(next.at) : null;
}

// What to do with one record now. Pure. → 'ask' | 'total' | 'close' | null
export function stepOf(r, { here, now }) {
  if (r.closedAt) return null;
  if (here) return !r.askedAt && now >= r.startMs ? 'ask' : null;
  return r.askedAt && r.status !== 'declined' ? 'total' : 'close';
}

export function initWaitingTime(app, { db, secret, send, recipients, etas = async () => ({}), baseUrl = 'https://tagalong-backend-fdzx.onrender.com', now = () => Date.now() }) {
  const enabled = !!(db && db.enabled);
  const all = async () => (await db.get(KEY(SITE), {})) || {};
  const patch = (k, fields) => db.update(KEY(SITE), (cur) => ({ ...(cur || {}), [k]: { ...(cur || {})[k], ...fields } }), {});
  const link = (r, x = false) => `${baseUrl}/wt/${makeToken({ k: r.key, t: r.trip, u: r.unit, s: r.stop, ...(x ? { x: true } : {}) }, secret, now(), PURPOSE, 3)}`;

  async function process(board) {
    if (!enabled) return;
    const items = (board && board.trips) || [];
    const stored = await all(); const firstRun = !(await db.get(`${KEY(SITE)}:began`, null));
    const legs = await etas();
    const fresh = {};
    for (const it of items) {
      const at = brokerLoad(it) ? atStop(it) : null;
      if (!at || Number.isNaN(at.arrivedMs) || now() - at.arrivedMs > STALE_MS) continue;
      const t = it.trip || {}; const trip = tripNo(it); const key = `${trip}:${at.arrivedMs}`;
      if (stored[key]) continue;
      const leg = ((legs[trip] || {}).stops || [])[0] || null;
      fresh[key] = { key, trip, unit: t.powerUnit || null, trailer: t.trailer || null, kind: at.kind, stop: (leg && leg.label) || null, arrivedMs: at.arrivedMs, apptMs: (leg && leg.apptMs) || null, startMs: clockStart(at.arrivedMs, leg && leg.apptMs), status: 'open', ...(firstRun ? { closedAt: now(), adopted: true } : {}) };   // already there on day one: no email for what we didn't watch
    }
    if (Object.keys(fresh).length) await db.update(KEY(SITE), (cur) => ({ ...fresh, ...(cur || {}) }), {});
    if (firstRun) await db.set(`${KEY(SITE)}:began`, now());
    const list = Object.values({ ...fresh, ...stored }).filter((r) => !r.closedAt);
    for (const r of list) {
      const it = items.find((x) => tripNo(x) === r.trip) || null;
      const a = it && atStop(it);
      const here = !!(a && a.arrivedMs === r.arrivedMs);
      const step = stepOf(r, { here, now: now() });
      if (!step) continue;
      if (step === 'close') { await patch(r.key, { closedAt: now() }); continue; } // eslint-disable-line no-await-in-loop
      try {
        if (step === 'ask') { await patch(r.key, { askedAt: now() }); await send('start', { ...r, askedAt: now() }, it, link(r), await recipients()); continue; } // eslint-disable-line no-await-in-loop
        const left = (it && leftAt(it, r.arrivedMs)) || now();
        const done = { ...r, leftMs: left, waitedMs: Math.max(0, left - r.startMs), closedAt: now() };
        await patch(r.key, done); await send('total', done, it, null, await recipients()); // eslint-disable-line no-await-in-loop
      } catch (e) { console.warn('[waiting-time]', r.key, e.message); }
    }
    const old = now() - KEEP_DAYS * 86400000;
    if (Object.values(stored).some((r) => r.closedAt && r.closedAt < old)) await db.update(KEY(SITE), (cur) => Object.fromEntries(Object.entries(cur || {}).filter(([, r]) => !r.closedAt || r.closedAt >= old)), {});
  }

  async function decide(p, { status, name, note }) {
    const by = oneLine(name, 80);
    if (!['approved', 'declined'].includes(status)) return { code: 400, error: 'Choose Approve or Don\'t approve.' };
    if (!by) return { code: 400, error: 'Add your name.' };
    if (p.x) return { code: 200, ok: true, example: true };
    const r = (await all())[p.k];
    if (!r || r.closedAt) return { code: 409, error: 'The truck already left.' };
    await patch(p.k, { status, decidedBy: by, decidedAt: now(), ...(oneLine(note, 300) ? { note: oneLine(note, 300) } : {}) });
    return { code: 200, ok: true };
  }

  async function overlay(site0, trips) {
    const open = Object.values(await all()).filter((r) => !r.closedAt);
    for (const it of trips) { const r = open.find((x) => x.trip === tripNo(it)); if (r) it._waiting = { startMs: r.startMs, status: r.status, kind: r.kind }; }
  }

  if (app) {
    app.get('/wt/:token', async (req, res) => {
      const p = readToken(req.params.token, secret, now(), PURPOSE);
      const r = p && !p.x ? (await all())[p.k] : null;
      const done = r && r.status !== 'open' ? `<p><b>${esc(r.decidedBy)}</b> marked this <b>${r.status === 'approved' ? 'approved' : 'not approved'}</b>.</p>` : '';
      res.set('Cache-Control', 'no-store').type('html').send(!p ? page('Link not valid', '<h1>This link has expired</h1>') : page('Waiting time', `<style>.t{display:flex;border:1px solid #B8C3D3;border-radius:8px;overflow:hidden}.t input{position:absolute;opacity:0;width:1px;height:1px}.t label{flex:1;margin:0;padding:14px 8px;text-align:center;color:#13325B;cursor:pointer}.t input:checked+label{color:#fff}.t input#a:checked+label{background:#166534}.t input#d:checked+label{background:#C62828}button.go{background:#13325B}</style><h1>Waiting time</h1><p class="s">Truck ${esc(p.u)} · Trip ${esc(p.t)}${p.s ? ` · ${esc(p.s)}` : ''}</p>${done}<form id="f"><div class="t" role="radiogroup" aria-label="Start the waiting time clock?"><input type="radio" name="s" id="a" value="approved"${req.query.d === 'approved' ? ' checked' : ''}><label for="a">Approve</label><input type="radio" name="s" id="d" value="declined"${req.query.d === 'declined' ? ' checked' : ''}><label for="d">Don't approve</label></div><label for="r">Note (optional)</label><textarea id="r" maxlength="300"></textarea><label for="n">Your name</label><input id="n" maxlength="80" required autocomplete="name"><button id="b" class="go" type="submit">Submit</button><div class="e" id="e" role="alert"></div></form><script>document.getElementById('f').addEventListener('submit',async function(ev){ev.preventDefault();var b=document.getElementById('b'),e=document.getElementById('e'),s=document.querySelector('input[name=s]:checked');e.textContent='';if(!s){e.textContent='Choose one.';return;}b.disabled=true;try{var x=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:s.value,note:document.getElementById('r').value,name:document.getElementById('n').value})});var j=await x.json();if(!x.ok)throw new Error(j.error||'Could not save.');document.querySelector('.c').innerHTML='<h1>Saved</h1><p class="s">You can close this page.</p>';}catch(y){e.textContent=y.message;b.disabled=false;}});</script>`));
    });
    app.post('/wt/:token', async (req, res) => {
      const p = readToken(req.params.token, secret, now(), PURPOSE);
      if (!p) return res.status(403).json({ error: 'This link has expired.' });
      try { const r = await decide(p, req.body || {}); return res.status(r.code).json(r); } catch (e) { console.warn('[waiting-time]', e.message); return res.status(500).json({ error: 'Could not save.' }); }
    });
  }
  return { process, overlay, decide, link, loadRows };
}
