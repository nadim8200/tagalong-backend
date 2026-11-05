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
import { readFileSync } from 'node:fs';
import { TRAINING_SLOT } from './latemail.js';

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

// The email's pictures ride inside it (cid), so they show without loading anything from outside: the trailer drawing and the
// decorative flower mark in the masthead (a mark, not the company logo).
const ASSET = (f) => { try { return readFileSync(new URL(`./assets/email/${f}`, import.meta.url)); } catch { return null; } };
const PICS = { trailer: ASSET('trailer.png'), flower: ASSET('flower-mark.png') };
const liveUrl = (trip) => `https://mytagalong.app/truckmate?admin&tab=active&trip=${encodeURIComponent(trip)}`;   // the signed-in console, on this trip
const SOURCE = { TruckMate: 'TruckMate', 'trip sheet vs TruckMate': 'Trip sheet vs TruckMate', 'reported by dispatch': 'Reported by dispatch' };
const etStamp = (iso) => { const d = new Date(iso); if (Number.isNaN(d.getTime())) return null; const o = { timeZone: 'America/New_York' }; return `${d.toLocaleDateString('en-US', { ...o, month: 'short', day: 'numeric', year: 'numeric' })} · ${d.toLocaleTimeString('en-US', { ...o, hour: 'numeric', minute: '2-digit' })} ET`; };

// "Trailer change recorded" (the approved design): old → new trailer tiles, trip and truck, what TruckMate shows, the details, a button to
// the trip in the console. Tables and inline styles only (Outlook, Gmail, Apple Mail); the tiles stack with a down arrow on a phone.
// It says TruckMate and the card show the new trailer only when TruckMate's trip really has it. Pure. → { subject, html, text, attachments }
export function renderTrailerChange(item, c) {
  const t = tripOf(item); const trip = tripNo(item) || 'Not provided';
  const route = [t.startZoneDescription || t.originZone, t.endZoneDescription || t.destZone].filter(Boolean).join(' → ') || null;
  const shows = !!t.trailer && unit(t.trailer) === unit(c.to);
  const subject = `Trailer change — Trip ${tripNo(item)} · TL ${c.from} → TL ${c.to}${t.powerUnit ? ` · Truck ${t.powerUnit}` : ''}`;
  const NAVY = '#13325B'; const COBALT = '#1D4ED8'; const TEXT = '#1F2937'; const MUTED = '#5B6778'; const LINE = '#D9E0EA'; const F = 'Arial,Helvetica,sans-serif';
  const big = (v) => { const n = String(v).length; return n > 12 ? 20 : n > 9 ? 24 : n > 7 ? 30 : n > 5 ? 40 : 52; };
  const pics = []; const pic = (key, alt, w, h) => { if (!PICS[key]) return ''; if (!pics.some((p) => p.cid === `tc-${key}`)) pics.push({ name: `${key}.png`, contentType: 'image/png', bytes: PICS[key], cid: `tc-${key}` }); return `<img src="cid:tc-${key}" width="${w}" height="${h}" alt="${esc(alt)}" style="display:block;margin:0 auto;border:0;width:${w}px;height:${h}px;">`; };
  const tile = (label, no, isNew) => `<td class="tc-tile" width="45%" valign="top" style="width:45%;padding:0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;background:${isNew ? '#EAF2FE' : '#F1F3F6'};border:${isNew ? `2px solid ${COBALT}` : '1px solid #E1E5EB'};border-radius:10px;" bgcolor="${isNew ? '#EAF2FE' : '#F1F3F6'}"><tr><td align="center" style="padding:16px 10px 14px;font-family:${F};">
<div style="font-size:15px;font-weight:bold;letter-spacing:1.5px;color:${isNew ? COBALT : '#26364D'};">${label}</div>
<div style="font-size:${big(no)}px;line-height:1.1;font-weight:bold;color:${NAVY};padding:6px 0 8px;word-break:break-all;">${esc(no)}</div>
${pic('trailer', `${label.toLowerCase()} ${no}`, 168, 62)}</td></tr></table></td>`;
  const field = (k, v) => `<td class="tc-field" width="49%" valign="top" style="width:49%;padding:0 0 8px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border:1px solid ${LINE};border-radius:6px;"><tr>
<td width="74" style="width:74px;padding:9px 0 9px 16px;font-family:${F};font-size:13px;font-weight:bold;letter-spacing:1px;color:#344256;">${k}</td>
<td style="padding:9px 14px 9px 12px;border-left:1px solid ${LINE};font-family:${F};font-size:21px;font-weight:bold;color:${NAVY};word-break:break-all;">${esc(v || 'Not provided')}</td></tr></table></td>`;
  const rows = [['Route', route], ['Reference', c.reason], ['Reported by', c.by || 'Jarvis'], ['Source', SOURCE[c.source] || c.source], ['Recorded', etStamp(c.at)]].map(([k, v]) => [k, v || 'Not provided']);
  const info = shows ? [`The load is now assigned to trailer ${c.to}.`, 'TruckMate and the trip card reflect the new trailer.'] : [`Trailer ${c.to} is recorded for this load.`, `TruckMate still shows trailer ${t.trailer || 'none'} on this trip. Update it there.`];
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(subject)}</title>
<style>@media only screen and (max-width:540px){.tc-wrap{padding:0!important}.tc-pad{padding-left:18px!important;padding-right:18px!important}.tc-h1{font-size:28px!important}.tc-mh{font-size:19px!important}.tc-ms{font-size:11px!important;letter-spacing:2px!important}.tc-tile,.tc-field{display:block!important;width:100%!important}.tc-arrow{display:block!important;width:100%!important;padding:8px 0!important;text-align:center!important}.tc-ar{display:none!important}.tc-ad{display:inline!important}.tc-gap{display:none!important}}</style></head>
<body style="margin:0;padding:0;background:#EEF2F7;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#EEF2F7" style="background:#EEF2F7;"><tr><td class="tc-wrap" align="center" style="padding:20px 10px;">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" bgcolor="#FFFFFF" style="width:100%;max-width:640px;background:#FFFFFF;border:1px solid ${LINE};">
<tr><td bgcolor="${NAVY}" style="background:${NAVY};padding:20px 24px;"><table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0"><tr>
${PICS.flower ? `<td valign="middle" style="padding-right:16px;border-right:1px solid #6F86A8;">${pic('flower', '', 52, 52)}</td>` : ''}
<td valign="middle" style="padding-left:${PICS.flower ? 16 : 0}px;font-family:${F};color:#FFFFFF;"><div class="tc-mh" style="font-size:27px;line-height:1.15;font-weight:bold;letter-spacing:.5px;">FLORIDA BEAUTY FLORA</div><div class="tc-ms" style="font-size:14px;letter-spacing:3px;padding-top:5px;color:#DCE6F5;">JARVIS &bull; DISPATCH UPDATE</div></td></tr></table></td></tr>
${TRAINING_SLOT}
<tr><td class="tc-pad" style="padding:22px 28px 0;font-family:${F};"><span style="display:inline-block;background:#E3EDFB;color:${COBALT};font-size:13px;font-weight:bold;letter-spacing:1.5px;padding:5px 10px;border-radius:4px;">EQUIPMENT UPDATE</span></td></tr>
<tr><td class="tc-pad tc-h1" style="padding:12px 28px 0;font-family:${F};font-size:38px;line-height:1.15;font-weight:bold;color:${NAVY};">Trailer change recorded</td></tr>
<tr><td class="tc-pad" style="padding:6px 28px 18px;font-family:${F};font-size:18px;line-height:1.4;color:#344256;">Same truck. Same trip. Updated trailer assignment.</td></tr>
<tr><td class="tc-pad" style="padding:0 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
${tile('PREVIOUS TRAILER', c.from, false)}
<td class="tc-arrow" width="10%" align="center" valign="middle" style="width:10%;font-family:${F};font-size:40px;line-height:1;font-weight:bold;color:${COBALT};"><span class="tc-ar">&rarr;</span><span class="tc-ad" style="display:none;mso-hide:all;">&darr;</span></td>
${tile('NEW TRAILER', c.to, true)}
</tr></table></td></tr>
<tr><td class="tc-pad" style="padding:16px 28px 4px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${field('TRIP', tripNo(item))}<td class="tc-gap" width="2%" style="width:2%;"></td>${field('TRUCK', t.powerUnit)}</tr></table></td></tr>
<tr><td class="tc-pad" style="padding:8px 28px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#E8F1FC" style="background:#E8F1FC;border-radius:6px;"><tr>
<td width="56" align="center" valign="middle" style="width:56px;padding:14px 0 14px 14px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" valign="middle" width="26" height="26" style="width:26px;height:26px;border:2px solid ${COBALT};border-radius:15px;font-family:Georgia,'Times New Roman',serif;font-size:16px;font-weight:bold;font-style:italic;color:${COBALT};line-height:26px;">i</td></tr></table></td>
<td valign="middle" style="padding:14px 18px 14px 12px;font-family:${F};font-size:16px;line-height:1.45;font-weight:bold;color:${NAVY};">${esc(info[0])}<br>${esc(info[1])}</td></tr></table></td></tr>
<tr><td class="tc-pad" style="padding:24px 28px 8px;font-family:${F};font-size:23px;font-weight:bold;color:${NAVY};border-bottom:0;">Change details</td></tr>
<tr><td class="tc-pad" style="padding:0 28px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:2px solid #B9C4D3;">${rows.map(([k, v]) => `<tr><td width="33%" valign="top" style="width:33%;padding:9px 10px 9px 4px;border-bottom:1px solid ${LINE};font-family:${F};font-size:15px;font-weight:bold;color:${TEXT};">${esc(k)}</td><td valign="top" style="padding:9px 4px;border-bottom:1px solid ${LINE};font-family:${F};font-size:15px;line-height:1.4;color:${TEXT};word-break:break-word;">${esc(v)}</td></tr>`).join('')}</table></td></tr>
${tripNo(item) ? `<tr><td align="center" style="padding:26px 28px 6px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="${COBALT}" style="background:${COBALT};border-radius:5px;"><a href="${esc(liveUrl(tripNo(item)))}" style="display:inline-block;padding:14px 38px;font-family:${F};font-size:20px;font-weight:bold;color:#FFFFFF;text-decoration:none;">View trip ${esc(tripNo(item))}</a></td></tr></table></td></tr>` : ''}
<tr><td class="tc-pad" style="padding:18px 28px 22px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" style="border-top:1px solid ${LINE};padding-top:14px;font-family:${F};font-size:15px;color:${NAVY};"><b>Jarvis &middot; AI Dispatcher</b><br><span style="font-size:14px;color:#344256;">Florida Beauty Flora</span></td></tr></table></td></tr>
</table></td></tr></table></body></html>`;
  const text = ['FLORIDA BEAUTY FLORA — Jarvis · Dispatch update', '', 'EQUIPMENT UPDATE', 'Trailer change recorded', 'Same truck. Same trip. Updated trailer assignment.', '', `Previous trailer: ${c.from}`, `New trailer: ${c.to}`, `Trip: ${trip}`, `Truck: ${t.powerUnit || 'Not provided'}`, '', ...info, '', 'CHANGE DETAILS', ...rows.map(([k, v]) => `${k}: ${v}`), '', ...(tripNo(item) ? [`View trip ${tripNo(item)}: ${liveUrl(tripNo(item))}`, ''] : []), 'Jarvis · AI Dispatcher', 'Florida Beauty Flora'].join('\n');
  return { subject, html, text, attachments: pics };
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
