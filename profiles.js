// ---------------------------------------------------------------
// Customer & broker profiles — one place for who we deliver to and who sends us loads.
//
//  • Built automatically from the loads: trip-sheet customers (stops, call-ahead
//    contacts), TruckMate bills (bill-to, consignee, caller) and rate cons (broker,
//    the broker's own office, every contact on it).
//  • A broker is one profile PER OFFICE (same company, an office in Alabama and one in
//    California = two profiles). The office comes from the rate con letterhead; when
//    it's unknown the contacts wait on "office not set" until a dispatcher fixes it.
//  • Dispatchers view and edit everything, add contacts, and mark a profile Verified.
//    Anything a person edited is never overwritten by the automatic sync.
//  • Each contact: "Status emails" (gets the automatic load emails) and "Authorized
//    caller" (can get load updates from Jarvis by phone). With "authorized numbers
//    only" on, Jarvis gives a customer's delivery details only to its authorized
//    numbers; a short list of numbers (owners…) can get updates on any load.
//  • Customer profiles download / upload as a spreadsheet (CSV) to add phones and
//    emails in bulk.
// ---------------------------------------------------------------
import { randomBytes } from 'crypto';
import { tmContact, billsOf, emailList, custKey } from './statusmail.js';

const SITE = 'florida-beauty';
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const last10 = (p) => { const d = String(p || '').replace(/\D+/g, ''); return d.length >= 10 ? d.slice(-10) : ''; };
const newId = () => randomBytes(5).toString('hex');
// "BOKHARY FARMS LLC *" / "Bokhary Farms, LLC." → "BOKHARY FARMS"
export const normName = (s) => String(s || '').toUpperCase().replace(/[*^>]+/g, ' ').replace(/\b(LLC|L\.L\.C|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD)\b\.?/g, ' ').replace(/[^A-Z0-9& ]+/g, ' ').replace(/\s+/g, ' ').trim();
const cleanName = (s) => String(s || '').replace(/[*^>]{2,}|\s*[*^>]+\s*$/g, '').replace(/\s+/g, ' ').trim();
const officeKey = (o) => (o && (o.city || o.state) ? `${String(o.city || '').toUpperCase().trim()},${String(o.state || '').toUpperCase().trim()}` : '');
export const profileKey = (type, name, office) => `${type}|${normName(name)}|${type === 'broker' ? officeKey(office) : ''}`;
const officeLabel = (o) => (o && (o.city || o.state) ? [o.city, o.state].filter(Boolean).join(', ') : null);

// What one load says about its customers and broker. Pure.
export function fromLoad(item, prefixes = ['B', 'R']) {
  const out = [];
  const add = (type, name, extra = {}) => {
    if (!name || !normName(name)) return;
    const k = profileKey(type, name, extra.office);
    let p = out.find((x) => x.key === k);
    if (!p) { p = { key: k, type, name: cleanName(name), office: extra.office || null, locations: [], contacts: [] }; out.push(p); }
    if (extra.location && !p.locations.includes(extra.location)) p.locations.push(extra.location);
    for (const c of extra.contacts || []) if (c && (c.email || last10(c.phone))) p.contacts.push({ name: c.name || null, role: c.role || 'other', email: c.email ? emailList(c.email)[0] || null : null, phone: last10(c.phone) || null, source: extra.source });
  };
  const sheet = (item && item._manifest) || {};
  for (const st of sheet.stops || []) {
    if (!/DELIVER/i.test(st.action || '')) continue;
    add('customer', st.customer, { location: [st.city, st.state].filter(Boolean).join(', '), source: 'trip sheet', contacts: (st.callAhead || []).map((c) => ({ name: c.contact, phone: c.phone, role: 'receiver' })) });
  }
  const p = prefixes.map((x) => String(x).toUpperCase());
  const rc = (item && item._ratecon && (item._ratecon.data || item._ratecon)) || {};
  for (const b of billsOf(item)) {
    const brokerBill = p.includes(String(b.billNumber || '').charAt(0).toUpperCase());
    const zone = String(b.endZoneDescription || '').replace(/,\s*\d{5}.*$/, '');
    if (!brokerBill && b.billToName) add('customer', b.billToName, { location: zone, source: 'TruckMate', contacts: [tmContact(b.billToCustomer), tmContact(b.consignee)].filter(Boolean).map((c) => ({ ...c, role: 'customer' })) });
    if (brokerBill && !rc.broker) {
      const c = tmContact(b.caller);
      if (c && c.company) add('broker', c.company, { source: 'TruckMate', contacts: [{ ...c, role: 'broker' }] });
    }
  }
  if (rc.broker) {
    const office = rc.brokerOffice && (rc.brokerOffice.city || rc.brokerOffice.state) ? { city: rc.brokerOffice.city || null, state: rc.brokerOffice.state || null, address: rc.brokerOffice.address || null } : null;
    const BROKER_ROLES = ['broker_rep', 'after_hours', 'dispatch', 'tracking', 'billing'];
    add('broker', rc.broker, { office, source: 'rate con', contacts: [{ role: 'broker', email: rc.brokerEmail, phone: rc.brokerPhone }, ...(rc.contacts || []).filter((c) => c && BROKER_ROLES.includes(c.role)).map((c) => ({ name: c.name, role: c.role, email: c.email, phone: c.phone }))] });
  }
  return out;
}

// Fold what the loads say into the saved profiles (never touching anything a person edited). Pure.
export function mergeInto(store, found, trip, now = new Date().toISOString()) {
  const all = { ...store };
  for (const f of found) {
    let p = Object.values(all).find((x) => x.key === f.key) || (f.type === 'broker' && !f.office ? null : null);
    if (!p) {
      const id = newId();
      p = { id, key: f.key, type: f.type, name: f.name, office: f.office, locations: [], contacts: [], aliases: [], notes: '', verified: null, edited: false, loads: [], createdAt: now, sources: [] };
    } else p = { ...p, contacts: [...(p.contacts || [])], locations: [...(p.locations || [])], loads: [...(p.loads || [])], sources: [...(p.sources || [])], aliases: [...(p.aliases || [])] };
    if (!p.aliases.includes(f.name) && f.name !== p.name) p.aliases.push(f.name);
    for (const l of f.locations) if (l && !p.locations.includes(l)) p.locations.push(l);
    for (const c of f.contacts) {
      if (!p.sources.includes(c.source)) p.sources.push(c.source);
      const same = p.contacts.find((x) => (c.email && x.email === c.email) || (c.phone && x.phone === c.phone));
      if (same) { if (!same.edited) { if (!same.phone && c.phone) same.phone = c.phone; if (!same.email && c.email) same.email = c.email; if (!same.name && c.name) same.name = c.name; } continue; }
      p.contacts.push({ id: newId(), name: c.name, role: c.role, email: c.email, phone: c.phone, statusEmails: f.type === 'broker' ? ['broker', 'broker_rep', 'tracking'].includes(c.role) : false, authorized: false, source: c.source, addedAt: now });
    }
    if (trip && !p.loads.some((x) => x.trip === trip)) p.loads = [{ trip, at: now }, ...p.loads].slice(0, 25);
    p.updatedAt = now;
    all[p.id] = p;
  }
  return all;
}

// Can this phone get a customer's delivery details from Jarvis? Pure.
// → { ok, why, profile }  (strict off, or the profile has no numbers yet → ok)
export function phoneAllowed({ profiles, settings = {}, customerName, phone }) {
  const P = last10(phone);
  if (P && (settings.anyLoad || []).some((x) => last10(x.phone) === P)) return { ok: true, why: 'authorized for every load' };
  const n = normName(customerName);
  const mine = Object.values(profiles || {}).filter((p) => p.type === 'customer' && (normName(p.name) === n || (p.aliases || []).some((a) => normName(a) === n) || (n && normName(p.name).includes(n)) || (n && n.includes(normName(p.name)))));
  const nums = mine.flatMap((p) => (p.contacts || []).filter((c) => c.authorized && c.phone).map((c) => c.phone));
  if (P && nums.includes(P)) return { ok: true, why: 'authorized number', profile: mine[0] };
  if (!settings.strict) return { ok: true, why: 'authorized-numbers rule is off', profile: mine[0] };
  return { ok: false, why: nums.length ? 'not one of the authorized numbers' : 'no authorized numbers on file for this customer', profile: mine[0] };
}

// ---- spreadsheet (CSV) ----
const CSV_COLS = ['profile_id', 'type', 'name', 'office_city', 'office_state', 'contact_name', 'role', 'email', 'phone', 'status_emails', 'authorized_caller'];
const q = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export function toCsv(profiles, type = null) {
  const rows = [CSV_COLS.join(',')];
  for (const p of Object.values(profiles).filter((x) => !type || x.type === type).sort((a, b) => a.name.localeCompare(b.name))) {
    const cs = (p.contacts || []).length ? p.contacts : [{}];
    for (const c of cs) rows.push([p.id, p.type, p.name, p.office && p.office.city, p.office && p.office.state, c.name, c.role, c.email, c.phone, c.statusEmails ? 'yes' : '', c.authorized ? 'yes' : ''].map(q).join(','));
  }
  return rows.join('\n');
}
export function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let inQ = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) { if (ch === '"' && s[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') inQ = false; else cell += ch; continue; }
    if (ch === '"') inQ = true; else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && s[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const head = (rows.shift() || []).map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.filter((r) => r.some((x) => String(x).trim())).map((r) => Object.fromEntries(head.map((h, i) => [h, String(r[i] == null ? '' : r[i]).trim()])));
}
const yes = (v) => /^(y|yes|true|1|x|si|sí)$/i.test(String(v || '').trim());
// Apply an uploaded sheet: rows matched by profile_id (else type + name + office); contacts upserted by email / phone. Pure.
export function applyCsv(profiles, rows, by = 'upload', now = new Date().toISOString()) {
  const all = JSON.parse(JSON.stringify(profiles || {}));
  let updated = 0; let created = 0; let contacts = 0;
  for (const r of rows) {
    const type = /broker/i.test(r.type) ? 'broker' : 'customer';
    if (!r.name && !r.profile_id) continue;
    const office = r.office_city || r.office_state ? { city: r.office_city || null, state: r.office_state || null } : null;
    let p = (r.profile_id && all[r.profile_id]) || Object.values(all).find((x) => x.key === profileKey(type, r.name, office));
    if (!p) { p = { id: newId(), key: profileKey(type, r.name, office), type, name: cleanName(r.name), office, locations: [], contacts: [], aliases: [], notes: '', verified: null, edited: true, loads: [], createdAt: now, sources: ['upload'] }; all[p.id] = p; created++; } else updated++;
    const email = r.email ? emailList(r.email)[0] || null : null; const phone = last10(r.phone) || null;
    if (!email && !phone) continue;
    let c = p.contacts.find((x) => (email && x.email === email) || (phone && x.phone === phone));
    if (!c) { c = { id: newId(), source: 'upload', addedAt: now }; p.contacts.push(c); }
    Object.assign(c, { name: r.contact_name || c.name || null, role: r.role || c.role || (type === 'broker' ? 'broker' : 'customer'), email: email || c.email || null, phone: phone || c.phone || null, statusEmails: yes(r.status_emails), authorized: yes(r.authorized_caller), edited: true, editedBy: by });
    p.edited = true; p.updatedAt = now; contacts++;
  }
  return { profiles: all, updated, created, contacts };
}

export function initProfiles(app, { requireAuth, db, getBoard = null, env = process.env }) {
  const enabled = !!(db && db.enabled);
  const key = `taProfiles:${SITE}`;
  const cfgKey = `taProfilesCfg:${SITE}`;
  const who = (req) => (req.user && (req.user.name || req.user.email)) || 'dispatcher';
  let cache = { at: 0, all: {}, cfg: {} };
  const load = async () => { if (Date.now() - cache.at < 20000) return cache; cache = { at: Date.now(), all: (await db.get(key, {})) || {}, cfg: (await db.get(cfgKey, {})) || {} }; return cache; };
  const save = async (fn) => { const v = await db.update(key, (cur) => fn({ ...(cur || {}) }), {}); cache = { ...cache, at: Date.now(), all: v }; return v; };

  // build / refresh profiles from the live board (and older saved per-customer emails)
  async function sync() {
    if (!enabled || !getBoard) return 0;
    const board = await getBoard(SITE);
    const legacy = ((await db.get('taStatusMailCfg', {})) || {}).customers || {};
    let n = 0;
    await save((all) => {
      let cur = all;
      for (const it of (board && board.trips) || []) { const f = fromLoad(it); n += f.length; cur = mergeInto(cur, f, tripNo(it)); }
      // emails typed in "Customer status emails" before profiles existed
      for (const [cust, emails] of Object.entries(legacy)) {
        cur = mergeInto(cur, [{ key: profileKey('customer', cust), type: 'customer', name: cust, office: null, locations: [], contacts: (emails || []).map((e) => ({ email: e, role: 'customer', source: 'saved emails' })) }], null);
        const p = Object.values(cur).find((x) => x.key === profileKey('customer', cust));
        if (p) p.contacts.forEach((c) => { if ((emails || []).includes(c.email)) c.statusEmails = true; });
      }
      return cur;
    });
    return n;
  }
  if (enabled && env.NODE_ENV !== 'test') {
    const t = setInterval(() => { sync().catch((e) => console.warn('[profiles] sync:', e.message)); }, 10 * 60000);
    if (t.unref) t.unref();
    setTimeout(() => { sync().catch(() => {}); }, 60000).unref?.();
  }

  // board overlay: each load's customer / broker profiles (status emails + authorized numbers)
  async function overlay(site, trips) {
    if (!enabled) return;
    const { all } = await load();
    const byKey = new Map(Object.values(all).map((p) => [p.key, p]));
    for (const it of trips) {
      const mine = fromLoad(it).map((f) => byKey.get(f.key)).filter(Boolean);
      if (mine.length) it._profiles = mine.map((p) => ({ id: p.id, type: p.type, name: p.name, office: officeLabel(p.office), verified: !!p.verified, contacts: (p.contacts || []).filter((c) => c.statusEmails || c.authorized).map((c) => ({ name: c.name, role: c.role, email: c.email, phone: c.phone, statusEmails: !!c.statusEmails, authorized: !!c.authorized })) }));
    }
  }
  async function allowed({ customerName, phone }) { const { all, cfg } = await load(); return phoneAllowed({ profiles: all, settings: cfg, customerName, phone }); }
  async function anyLoad(phone) { const { cfg } = await load(); const P = last10(phone); return !!(P && (cfg.anyLoad || []).some((x) => last10(x.phone) === P)); }

  const view = (p) => ({ ...p, officeLabel: officeLabel(p.office) });
  app.get('/truckmate/profiles', requireAuth, async (req, res) => {
    const { all } = await load();
    const qy = String(req.query.q || '').toUpperCase();
    const list = Object.values(all).filter((p) => (!req.query.type || p.type === req.query.type) && (!qy || `${p.name} ${(p.aliases || []).join(' ')} ${officeLabel(p.office) || ''} ${(p.contacts || []).map((c) => `${c.name} ${c.email} ${c.phone}`).join(' ')}`.toUpperCase().includes(qy)));
    res.json(list.sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ id: p.id, type: p.type, name: p.name, office: officeLabel(p.office), contacts: (p.contacts || []).length, authorized: (p.contacts || []).filter((c) => c.authorized).length, statusEmails: (p.contacts || []).filter((c) => c.statusEmails).length, verified: p.verified, lastLoad: (p.loads || [])[0] || null, locations: (p.locations || []).slice(0, 3) })));
  });
  app.get('/truckmate/profiles/settings', requireAuth, async (req, res) => { const { cfg } = await load(); res.json({ strict: !!cfg.strict, anyLoad: cfg.anyLoad || [] }); });
  app.put('/truckmate/profiles/settings', requireAuth, async (req, res) => {
    const b = req.body || {};
    const anyLoad = (Array.isArray(b.anyLoad) ? b.anyLoad : []).map((x) => ({ name: String(x.name || '').slice(0, 80), phone: last10(x.phone) })).filter((x) => x.phone).slice(0, 30);
    const v = await db.update(cfgKey, (cur) => ({ ...(cur || {}), strict: !!b.strict, anyLoad, updatedBy: who(req), updatedAt: new Date().toISOString() }), {});
    cache.at = 0;
    res.json({ strict: v.strict, anyLoad: v.anyLoad });
  });
  app.get('/truckmate/profiles/export.csv', requireAuth, async (req, res) => {
    const { all } = await load();
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${req.query.type === 'broker' ? 'broker' : req.query.type === 'customer' ? 'customer' : 'all'}-profiles.csv"`);
    res.send(toCsv(all, req.query.type === 'broker' || req.query.type === 'customer' ? req.query.type : null));
  });
  app.post('/truckmate/profiles/import', requireAuth, async (req, res) => {
    const rows = parseCsv(String((req.body && req.body.csv) || '').slice(0, 2_000_000));
    if (!rows.length) return res.status(400).json({ error: 'The file has no rows.' });
    let result;
    await save((all) => { result = applyCsv(all, rows, who(req)); return result.profiles; });
    res.json({ rows: rows.length, created: result.created, updated: result.updated, contacts: result.contacts });
  });
  app.post('/truckmate/profiles/sync', requireAuth, async (req, res) => { try { res.json({ ok: true, seen: await sync() }); } catch (e) { res.status(500).json({ error: e.message }); } });
  app.post('/truckmate/profiles', requireAuth, async (req, res) => {
    const b = req.body || {};
    const type = b.type === 'broker' ? 'broker' : 'customer';
    if (!String(b.name || '').trim()) return res.status(400).json({ error: 'Name required.' });
    const office = b.office && (b.office.city || b.office.state) ? { city: b.office.city || null, state: b.office.state || null, address: b.office.address || null } : null;
    const p = { id: newId(), key: profileKey(type, b.name, office), type, name: cleanName(b.name), office, locations: [], contacts: [], aliases: [], notes: '', verified: null, edited: true, loads: [], createdAt: new Date().toISOString(), sources: ['added by hand'] };
    await save((all) => ({ ...all, [p.id]: p }));
    res.json(view(p));
  });
  app.get('/truckmate/profiles/:id', requireAuth, async (req, res) => { const p = (await load()).all[req.params.id]; return p ? res.json(view(p)) : res.status(404).json({ error: 'Not found.' }); });
  app.put('/truckmate/profiles/:id', requireAuth, async (req, res) => {
    const b = req.body || {};
    let out = null;
    await save((all) => {
      const p = all[req.params.id];
      if (!p) return all;
      const office = b.office !== undefined ? (b.office && (b.office.city || b.office.state) ? { city: b.office.city || null, state: b.office.state || null, address: b.office.address || null } : null) : p.office;
      const name = b.name ? cleanName(b.name) : p.name;
      const contacts = Array.isArray(b.contacts) ? b.contacts.map((c) => ({ id: c.id || newId(), name: c.name ? String(c.name).slice(0, 80) : null, role: String(c.role || 'other').slice(0, 30), email: c.email ? emailList(c.email)[0] || null : null, phone: last10(c.phone) || null, statusEmails: !!c.statusEmails, authorized: !!c.authorized, source: c.source || 'edited', edited: true, editedBy: who(req) })).filter((c) => c.email || c.phone) : p.contacts;
      out = { ...p, name, office, key: profileKey(p.type, name, office), contacts, notes: b.notes != null ? String(b.notes).slice(0, 2000) : p.notes, verified: b.verified === true ? { by: who(req), at: new Date().toISOString() } : b.verified === false ? null : p.verified, edited: true, updatedAt: new Date().toISOString() };
      return { ...all, [p.id]: out };
    });
    return out ? res.json(view(out)) : res.status(404).json({ error: 'Not found.' });
  });
  app.post('/truckmate/profiles/:id/merge', requireAuth, async (req, res) => {
    const into = String((req.body && req.body.into) || '');
    let out = null;
    await save((all) => {
      const a = all[req.params.id]; const b = all[into];
      if (!a || !b || a.id === b.id) return all;
      const contacts = [...b.contacts];
      for (const c of a.contacts) if (!contacts.some((x) => (c.email && x.email === c.email) || (c.phone && x.phone === c.phone))) contacts.push(c);
      out = { ...b, contacts, aliases: [...new Set([...(b.aliases || []), a.name, ...(a.aliases || [])])].filter((x) => x !== b.name), loads: [...b.loads, ...a.loads.filter((l) => !b.loads.some((x) => x.trip === l.trip))].slice(0, 25), locations: [...new Set([...(b.locations || []), ...(a.locations || [])])], edited: true, updatedAt: new Date().toISOString() };
      const next = { ...all, [b.id]: out };
      delete next[a.id];
      return next;
    });
    return out ? res.json(view(out)) : res.status(400).json({ error: 'Pick a different profile to merge into.' });
  });
  app.delete('/truckmate/profiles/:id', requireAuth, async (req, res) => { await save((all) => { const n = { ...all }; delete n[req.params.id]; return n; }); res.json({ ok: true }); });

  console.log(`[profiles] customer & broker profiles ${enabled ? 'ready' : 'OFF — needs DATABASE_URL'}`);
  return { sync, overlay, allowed, anyLoad };
}
