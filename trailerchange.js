// Trailer change on the same trip. A trailer breaks down (axle, reefer…) and the load is cross-docked onto another
// trailer, or dispatch swaps trailers on the road: the trip stays the same, TruckMate gets the new trailer. Jarvis
// records it, emails the Truck transfer list once ("Trailer change — Trip 626344 · TL 7328 → TL 7371 · Truck 4550"),
// shows it on the card and timeline, and the trip sheet's old trailer stops counting as a mismatch.
//
// How it's noticed:
//   • TruckMate's trailer changes on a trip already followed (the trailer each trip had is remembered), or
//   • first time we see the trip, the sheet's trailer ≠ TruckMate's and the load's emails talk about the old trailer
//     breaking down / a cross-dock / a transfer (a sheet typo alone is not a trailer change), or
//   • a dispatcher reports it (Jarvis "trailer change on 626344 to 7371" or the route).
const SITE = 'florida-beauty';
const tripOf = (it) => (it && it.trip) || it || {};
const tripNo = (it) => String(tripOf(it).tripNumber || '');
const unit = (x) => String(x == null ? '' : x).replace(/^(TL|TRL|TRAILER)\s*#?\s*/i, '').replace(/[^0-9A-Z]/gi, '').replace(/^0+(?=\d)/, '').toUpperCase();
const DONE = /^(delvd|deliv|del$|cmplt|complete|canc|void)/i;
const isOc = (t) => /^OC\s?-?\d*$/i.test(String(t.trailer || '').trim()) || /^OC\s?-?\d*$/i.test(String(t.powerUnit || '').trim());
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// The load's emails that say the old trailer broke down / was cross-docked / transferred. Pure. → the subject or null
export function changeEvidence(item, oldTrailer) {
  const o = unit(oldTrailer); if (!o) return null;
  const said = (e) => `${e.subject || ''} ${e.text || ''}`;
  const hit = ((item && item._comms) || []).find((e) => e && e.type === 'email' && new RegExp(`\\b(TL|TRL|TRAILER)?\\s*#?\\s*0*${o}\\b`, 'i').test(said(e)) && /break\s?down|broke|axle|cross.?dock|transfer|swap|new trailer|change(d)? trailer|reefer (down|fail)/i.test(said(e)));
  return hit ? String(hit.subject || 'email about the old trailer').slice(0, 160) : null;
}

// What changed on this trip since we last looked. Pure. → { from, to, source, reason } | null
export function trailerChange(item, seenTrailer, { known = [] } = {}) {
  const t = tripOf(item);
  if (!t.trailer || isOc(t) || DONE.test(String(t.status || ''))) return null;
  const now = unit(t.trailer);
  if (seenTrailer) return unit(seenTrailer) !== now ? { from: String(seenTrailer), to: String(t.trailer), source: 'TruckMate', reason: changeEvidence(item, seenTrailer) } : null;
  const sheet = item && item._manifest && item._manifest.trailer;
  if (!sheet || unit(sheet) === now) return null;
  if (known.some((c) => unit(c.from) === unit(sheet) && unit(c.to) === now)) return null;
  const reason = changeEvidence(item, sheet);
  return reason ? { from: String(sheet), to: String(t.trailer), source: 'trip sheet vs TruckMate', reason } : null;
}

export function renderTrailerChange(item, c) {
  const t = tripOf(item); const s = (item && item._samsara) || {};
  const route = [t.startZoneDescription || t.originZone, t.endZoneDescription || t.destZone].filter(Boolean).join(' → ');
  const drivers = [s.driver1, s.driver2].filter(Boolean).join(' & ');
  const subject = `Trailer change — Trip ${tripNo(item)} · TL ${c.from} → TL ${c.to}${t.powerUnit ? ` · Truck ${t.powerUnit}` : ''}`;
  const rows = [['Trip', tripNo(item)], ['Truck', t.powerUnit || '—'], ['Old trailer', `TL ${c.from}`], ['New trailer', `TL ${c.to}`], ...(drivers ? [['Drivers', drivers]] : []), ...(route ? [['Route', route]] : []), ...(c.reason ? [['Why', c.reason]] : []), ['Reported by', c.by || `Jarvis (${c.source})`], ['When', new Date(c.at).toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }) + ' ET']];
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0f172a"><p style="font-size:18px;font-weight:700;margin:0 0 10px">Trailer change on trip ${esc(tripNo(item))}: TL ${esc(c.from)} → TL ${esc(c.to)}</p><p style="margin:0 0 12px">Same trip and truck; the load is now on trailer <b>${esc(c.to)}</b>. TruckMate and the trip card use the new trailer from here on.</p><table cellpadding="6" style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="color:#64748b;border-bottom:1px solid #e2e8f0">${esc(k)}</td><td style="border-bottom:1px solid #e2e8f0"><b>${esc(v)}</b></td></tr>`).join('')}</table><p style="color:#64748b;margin-top:14px">Jarvis · AI Dispatcher · Florida Beauty</p></div>`;
  const text = [`Trailer change on trip ${tripNo(item)}: TL ${c.from} → TL ${c.to}`, '', ...rows.map(([k, v]) => `${k}: ${v}`), '', 'Jarvis · AI Dispatcher · Florida Beauty'].join('\n');
  return { subject, html, text };
}

export function initTrailerChange({ db, sendMail = null, recipients = async () => [], now = () => Date.now() } = {}) {
  const enabled = !!(db && db.enabled);
  const SEEN = (site) => `taTrailerSeen:${site}`;
  const CHANGES = (site) => `taTrailerChanges:${site}`;

  async function record(site, item, c) {
    const trip = tripNo(item);
    const entry = { from: c.from, to: c.to, at: new Date(now()).toISOString(), truck: tripOf(item).powerUnit || null, source: c.source, reason: c.reason || null, by: c.by || null };
    let fresh = false;
    await db.update(CHANGES(site), (cur) => {
      const all = { ...(cur || {}) }; const list = all[trip] || [];
      if (list.some((x) => unit(x.from) === unit(entry.from) && unit(x.to) === unit(entry.to))) return all;
      fresh = true; all[trip] = [...list, entry].slice(-10); return all;
    }, {});
    await db.update(SEEN(site), (cur) => ({ ...(cur || {}), [trip]: String(c.to) }), {});
    if (!fresh) return { ok: true, duplicate: true };
    let emailed = false;
    try {
      const to = await recipients();
      if (sendMail && to && to.length) { await sendMail({ to, ...renderTrailerChange(item, entry) }); emailed = true; }
    } catch (e) { console.warn('[trailer-change] email:', e.message); }
    if (emailed) await db.update(CHANGES(site), (cur) => ({ ...(cur || {}), [trip]: ((cur || {})[trip] || []).map((x) => (x.at === entry.at ? { ...x, emailedAt: new Date(now()).toISOString() } : x)) }), {});
    return { ok: true, emailed, change: entry };
  }

  // every board refresh: what each trip's trailer is now, and anything that changed
  async function process(site, trips) {
    if (!enabled) return 0;
    const [seen, changes] = await Promise.all([db.get(SEEN(site), {}), db.get(CHANGES(site), {})]);
    const next = {}; let found = 0;
    for (const it of trips || []) {
      const trip = tripNo(it); const t = tripOf(it);
      if (!trip || !t.trailer) continue;
      const c = trailerChange(it, (seen || {})[trip], { known: (changes || {})[trip] || [] });
      if (c) { await record(site, it, c); found += 1; } // eslint-disable-line no-await-in-loop
      next[trip] = String(t.trailer);
    }
    await db.update(SEEN(site), (cur) => ({ ...Object.fromEntries(Object.entries(cur || {}).filter(([k]) => next[k])), ...next }), {});
    return found;
  }

  // on the board: the changes, and the sheet's old trailer is no longer a mismatch
  async function overlay(site, trips) {
    if (!enabled) return;
    const changes = (await db.get(CHANGES(site), {})) || {};
    for (const it of trips || []) {
      const list = changes[tripNo(it)];
      if (!list || !list.length) continue;
      it._trailerChanges = list;
      const m = it._manifest;
      if (m && Array.isArray(m.diffs) && m.trailer && list.some((c) => unit(c.from) === unit(m.trailer))) m.diffs = m.diffs.filter((d) => d.kind !== 'trailer');
    }
  }

  // a dispatcher reports it (Jarvis, or the route)
  async function report(site, item, { to, by, reason = null }) {
    const t = tripOf(item); const sheet = item._manifest && item._manifest.trailer;
    // TruckMate may already show the new trailer: then the old one is the sheet's
    const from = String(t.trailer && unit(t.trailer) !== unit(to) ? t.trailer : sheet || '');
    if (!to || !from || unit(to) === unit(from)) return { ok: false, error: `Trip ${tripNo(item)} is already on trailer ${to}${from ? '' : ' (no earlier trailer on record)'}.` };
    return record(site, item, { from: from || '?', to: String(to), source: 'reported by dispatch', by, reason });
  }

  return { process, overlay, report, list: async (site = SITE) => (await db.get(CHANGES(site), {})) || {} };
}
