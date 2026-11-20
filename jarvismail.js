// ---------------------------------------------------------------
// The Jarvis operations email (Nov 19 design): navy header "FLORIDA BEAUTY FLORA / JARVIS / OPERATIONS UPDATE", a status label,
// a big title, the customer or equipment, the report number and time, one short panel with what to do, the driver's own words,
// grouped facts, location, paperwork, photos, and the Jarvis signature. Built from presentation tables and inline styles so
// Outlook, Gmail and Apple Mail show it the same; one small <style> only for phones and dark mode. Every piece of text that
// comes from a report goes through esc(); links are checked before they are written. Pure.
// ---------------------------------------------------------------
export const C = { page: '#e9eef5', navy: '#142f54', ink: '#192d48', muted: '#65778c', label: '#60748b', line: '#e5ebf2', border: '#d4deea', panel: '#f0f4f9', quote: '#eef3f9',
  amber: '#b45309', amberTint: '#fff7e8', amberLine: '#ecd4a6', red: '#b42318', blue: '#2459a6', file: '#f5f7fb', fileLine: '#dde5ef' };
export const TONE = { amber: C.amber, red: C.red, blue: C.blue };
const FONT = 'Arial,Helvetica,sans-serif';
export const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// only http(s) links, written as they are (no javascript:, no quotes)
export const safeUrl = (u) => (/^https?:\/\/[^\s"'<>]+$/i.test(String(u || '')) ? String(u) : null);
export const telHref = (digits) => { const d = String(digits || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `tel:+1${d}` : null; };
export const fmtPhone = (digits) => { const d = String(digits || '').replace(/\D/g, '').slice(-10); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : null; };
// a map link only for real coordinates (no blank, no null, no 0,0)
const coord = (x) => (x === null || x === undefined || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
export const mapUrl = (lat, lng) => { const a = coord(lat); const b = coord(lng); return a !== null && b !== null && Math.abs(a) <= 90 && Math.abs(b) <= 180 && !(a === 0 && b === 0) ? `https://maps.google.com/?q=${a.toFixed(5)},${b.toFixed(5)}` : null; };
export const etTime = (ms) => `${new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET`;
// "SOUTH WINDSOR, CT" → "South Windsor, CT". Pure.
export const cityState = (x) => String(x || '').trim().toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/,\s*([a-z]{2})$/i, (m, st) => `, ${st.toUpperCase()}`);
// the driver wrote in Spanish? (accents, ¿ ¡ ñ, or everyday Spanish words). Pure.
export const isSpanish = (t) => /[áéíóúñ¿¡]/i.test(String(t || '')) || /\b(el|la|los|las|una?|que|est[aá]|llant|caja|faltan?|cliente|lleg[oó]|cami[oó]n|tr[aá]iler|motor|frenos?|carro|me|se|del|por|para|con|no hay)\b/i.test(String(t || ''));

const p = (style, html) => `<p style="margin:0;${style}">${html}</p>`;
const label = (t) => `<p style="margin:0 0 10px;font-family:${FONT};font-size:11px;letter-spacing:.12em;font-weight:bold;color:${C.label};text-transform:uppercase">${esc(t)}</p>`;
const gap = (h = 24) => `<tr><td style="height:${h}px;line-height:${h}px;font-size:1px">&nbsp;</td></tr>`;
const row = (inner) => `<tr><td style="font-family:${FONT}">${inner}</td></tr>`;

// one section. Pure.
export const section = (title, inner) => `${gap()}${row(`${label(title)}${inner}`)}`;
// the driver's own words in the blue-gray panel, with the language and time under it. Pure.
export function quote(text, note) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td class="jm-quote" style="background:${C.quote};border-radius:10px;padding:16px 18px;font-family:${FONT};font-size:16px;line-height:1.6;color:${C.ink};white-space:pre-line">${esc(text)}</td></tr></table>${note ? p(`padding-top:6px;font-family:${FONT};font-size:12px;color:${C.muted}`, esc(note)) : ''}`;
}
// label / value rows. Values are already-safe HTML only when given as { html }. Pure.
export function facts(rows) {
  const r = rows.filter(Boolean).map(([k, v]) => `<tr><td class="jm-k" width="36%" valign="top" style="padding:10px 16px 10px 0;border-bottom:1px solid ${C.line};font-family:${FONT};font-size:14px;color:#63748a">${esc(k)}</td><td valign="top" style="padding:10px 0;border-bottom:1px solid ${C.line};font-family:${FONT};font-size:14px;font-weight:bold;color:${C.ink}">${v && v.html != null ? v.html : esc(v)}</td></tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${r}</table>`;
}
// the count strip: EXPECTED | DELIVERED | MISSING | PALLETS. Pure.
export function metrics(cells) {
  const td = cells.map(([k, v, tone]) => `<td align="center" valign="top" style="padding:12px 4px;font-family:${FONT}"><span style="display:block;font-size:9px;letter-spacing:.06em;color:#7b6b4c">${esc(k)}</span><span style="display:block;font-size:28px;font-weight:bold;line-height:1.2;color:${tone || C.ink}">${esc(v)}</span></td>`).join('');
  return `${gap(20)}${row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.amberTint};border-radius:10px"><tr>${td}</tr></table>`)}`;
}
// the amber "needs a person to look" box. Pure.
export const notice = (title, text) => `${gap(20)}${row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:#fff6e6;border:1px solid ${C.amberLine};border-radius:10px;padding:16px;font-family:${FONT};font-size:13px;color:${C.ink}"><b>${esc(title)}</b><br>${esc(text)}</td></tr></table>`)}`;
// one file: its name, then what really happened to it (attached, link only). Pure.
export function fileBox(name, status, url = null) {
  const u = safeUrl(url);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:8px"><tr><td style="background:${C.file};border:1px solid ${C.fileLine};border-radius:8px;padding:12px 14px;font-family:${FONT};font-size:14px;color:${C.ink}"><b>${u ? `<a href="${esc(u)}" style="color:${C.ink};text-decoration:underline">${esc(name)}</a>` : esc(name)}</b><br><span style="font-size:12px;color:${C.muted}">${esc(status)}</span></td></tr></table>`;
}
// the location: coordinates, where they came from and when, and the map button (only with real coordinates). Pure.
export function location({ lat, lng, source, at, address = null, text = null }) {
  const map = mapUrl(lat, lng);
  const coords = map ? `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}` : null;
  const from = source === 'truck' ? 'truck GPS' : source === 'phone' ? "driver's phone" : null;
  const lines = [address, text, coords ? `${coords}${from ? ` (${from}${at ? `, as of ${etTime(Date.parse(at))}` : ''})` : ''}` : null].filter(Boolean);
  const body = lines.length ? lines.map((l) => p(`font-family:${FONT};font-size:15px;color:${C.ink};padding-bottom:4px`, esc(l))).join('') : p(`font-family:${FONT};font-size:15px;color:${C.muted}`, 'No location was sent with this report.');
  return `${body}${map ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px"><tr><td style="background:${C.navy};border-radius:8px"><a href="${esc(map)}" style="display:inline-block;padding:12px 18px;font-family:${FONT};font-size:13px;font-weight:bold;color:#ffffff;text-decoration:none">Open location in maps &#8599;</a></td></tr></table>` : ''}`;
}

// The whole email. Pure. → html
export function jarvisEmail({ test = false, preheader = '', eyebrow, tone = 'amber', title, subtitle = null, place = null, meta = [], lead = null, action = null, body = '' }) {
  const act = action && safeUrl(action.url) ? action : null;
  const color = TONE[tone] || C.amber;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light"><title>${esc(title)}</title>
<style>@media (max-width:480px){.jm-pad{padding:22px 18px !important}.jm-h1{font-size:26px !important}.jm-k{width:38% !important}.jm-outer{padding:16px 8px !important}}</style></head>
<body style="margin:0;padding:0;background:${C.page}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page};font-size:1px;line-height:1px">${esc(preheader)}&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page}"><tr><td class="jm-outer" align="center" style="padding:28px 16px">
${test ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px"><tr><td align="center" style="padding-bottom:12px;font-family:${FONT};font-size:11px;letter-spacing:.07em;font-weight:bold;color:#7b5a13">TEST · SAMPLE DATA · NOT A REAL REPORT</td></tr></table>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background:#ffffff;border:1px solid ${C.border};border-radius:16px;border-collapse:separate;overflow:hidden">
<tr><td class="jm-pad" style="background:${C.navy};padding:24px 28px;border-radius:15px 15px 0 0;font-family:${FONT}">${p('font-size:16px;font-weight:bold;letter-spacing:.08em;color:#ffffff', 'FLORIDA BEAUTY FLORA')}${p('padding-top:6px;font-size:10px;letter-spacing:.14em;color:#bacce3', 'JARVIS / OPERATIONS UPDATE')}</td></tr>
<tr><td class="jm-pad" style="padding:28px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${row(`${p(`font-size:11px;letter-spacing:.09em;font-weight:bold;color:${color};text-transform:uppercase`, esc(eyebrow))}<h1 class="jm-h1" style="margin:10px 0;font-family:${FONT};font-size:30px;line-height:1.15;letter-spacing:-.5px;color:${C.ink}">${esc(title)}</h1>${subtitle ? `<h2 style="margin:0;font-family:${FONT};font-size:18px;line-height:1.35;color:${C.ink}">${esc(subtitle)}</h2>` : ''}${place ? p(`padding-top:5px;font-size:15px;color:#52677e`, esc(place)) : ''}${meta.length ? p(`padding:12px 0 0;font-size:12px;color:#60758c`, meta.filter(Boolean).map(esc).join(' &nbsp;&middot;&nbsp; ')) : ''}`)}
${lead ? `${gap(20)}${row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${C.panel};border-left:4px solid ${color};border-radius:0 8px 8px 0;padding:16px;font-family:${FONT};font-size:14px;line-height:1.5;color:${C.ink}">${esc(lead)}</td></tr></table>`)}` : ''}
${act ? `${gap(16)}${row(`<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${C.navy};border-radius:8px"><a href="${esc(act.url)}" style="display:inline-block;padding:13px 20px;font-family:${FONT};font-size:14px;font-weight:bold;color:#ffffff;text-decoration:none">${esc(act.label)} &#8594;</a></td></tr></table>`)}` : ''}
${body}
${gap(28)}<tr><td style="border-top:1px solid #dbe4ef;padding-top:22px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td valign="middle" style="padding-right:12px"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="46" height="46" align="center" valign="middle" style="width:46px;height:46px;border-radius:23px;background:${C.navy};color:#ffffff;font-family:${FONT};font-size:22px;font-weight:bold">J</td></tr></table></td><td valign="middle" style="font-family:${FONT};font-size:13px;line-height:1.5;color:${C.ink}"><b>Jarvis</b><br>AI Dispatcher<br><span style="color:${C.muted}">Florida Beauty Flora</span></td></tr></table></td></tr>
</table></td></tr></table>
</td></tr></table></body></html>`;
}
