// The still map in the truck emails: real map tiles around the truck's GPS, a marker, and the status drawn on top, as one PNG.
// Moving: a street map of the area (OpenStreetMap). Stopped: a satellite close-up (Esri World Imagery with its road names), so you can see which lot it's in.
// Nothing about the driver or load goes to the map server, only the tile numbers. If tiles fail: null, and the email goes without a picture.
// Tiles are credited on the image, sent with a contact, and kept an hour. Fine for a few emails a day.
import { createRequire } from 'node:module';
import path from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import jpeg from 'jpeg-js';

const require = createRequire(import.meta.url);
const FONT_DIR = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');
const FONTS = [path.join(FONT_DIR, 'DejaVuSans.ttf'), path.join(FONT_DIR, 'DejaVuSans-Bold.ttf')];
const W = 1184; const H = 560; const TILE = 384;   // 256px tiles drawn at 1.5× so street names stay readable on a phone
const ZOOM = 12;
const CLOSE_ZOOM = 18;
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const LAYERS = {
  street: { zoom: ZOOM, credit: '© OpenStreetMap contributors', tiles: [(z, x, y) => ({ url: `https://tile.openstreetmap.org/${z}/${x}/${y}.png`, mime: 'image/png' })] },
  close: { zoom: CLOSE_ZOOM, credit: 'Imagery © Esri, Maxar, Earthstar Geographics', tiles: [(z, x, y) => ({ url: `${ESRI}/World_Imagery/MapServer/tile/${z}/${y}/${x}`, mime: 'image/jpeg' }), (z, x, y) => ({ url: `${ESRI}/Reference/World_Transportation/MapServer/tile/${z}/${y}/${x}`, mime: 'image/png' })] },
};
const TRUCK_X = Math.round(W * 0.7);   // right of center, clear of the info box
const AGENT = 'FloridaBeautyDispatch/1.0 (ntellez@floridabeauty.us)';
const TONES = { green: { main: '#166534', pin: '#16A34A', bg: '#F0FDF4' }, red: { main: '#C62828', pin: '#DC2626', bg: '#FFF1F2' }, blue: { main: '#13325B', pin: '#0B5CC8', bg: '#FFFFFF' } };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cache = new Map();   // z/x/y → { at, b64 }
const HOUR = 3600000;

// Which tiles cover the picture and where each goes, with the truck at (cx, h / 2). Pure.
export function tileGrid(lat, lng, zoom = ZOOM, w = W, h = H, size = TILE, cx = TRUCK_X) {
  const n = 2 ** zoom;
  const fx = ((lng + 180) / 360) * n;
  const r = (lat * Math.PI) / 180;
  const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  const left = fx * size - cx; const top = fy * size - h / 2;
  const out = [];
  for (let y = Math.floor(top / size); y * size < top + h; y += 1) {
    for (let x = Math.floor(left / size); x * size < left + w; x += 1) {
      if (y >= 0 && y < n) out.push({ x: ((x % n) + n) % n, y, px: Math.round(x * size - left), py: Math.round(y * size - top) });
    }
  }
  return out;
}

async function tile({ url, mime }, fetchFn, now) {
  const hit = cache.get(url);
  if (hit && now - hit.at < HOUR) return hit.href;
  const r = await fetchFn(url, { headers: { 'User-Agent': AGENT } });
  if (!r.ok) throw new Error(`tile ${r.status}`);
  const href = `data:${mime};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
  if (cache.size > 300) cache.clear();
  cache.set(url, { at: now, href });
  return href;
}

// The picture as SVG, from tiles already fetched. Pure. big: "4m", label: "ROLLING", lines: up to 3 small lines.
export function mapSvg(tiles, { tone = 'blue', big = null, label = null, lines = [], credit = LAYERS.street.credit } = {}) {
  const c = TONES[tone] || TONES.blue;
  const cx = TRUCK_X; const cy = H / 2;
  const rows = lines.filter(Boolean).slice(0, 3);
  const panelH = 118 + rows.length * 36;
  const panelW = 560;
  const panel = big ? `<rect x="24" y="24" width="${panelW}" height="${panelH}" rx="18" fill="${c.bg}" stroke="${c.main}" stroke-width="3" fill-opacity="0.96"/>
<text x="52" y="100" font-family="DejaVu Sans" font-weight="700" font-size="68" fill="${c.main}">${esc(big)}<tspan dx="20" font-size="30">${esc(label || '')}</tspan></text>
${rows.map((l, i) => `<text x="52" y="${146 + i * 36}" font-family="DejaVu Sans" font-size="25" fill="#1F2937">${esc(l)}</text>`).join('')}` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#E5EBF1"/>
${tiles.map((t) => `<image x="${t.px}" y="${t.py}" width="${TILE}" height="${TILE}" xlink:href="${t.href}"/>`).join('')}
<circle cx="${cx}" cy="${cy}" r="58" fill="${c.pin}" fill-opacity="0.2"/><circle cx="${cx}" cy="${cy}" r="30" fill="${c.pin}" stroke="#FFFFFF" stroke-width="6"/>
<g fill="#FFFFFF" transform="translate(${cx - 17} ${cy - 11})"><rect x="0" y="0" width="21" height="16" rx="2"/><path d="M22 5h7l5 6v5H22z"/><circle cx="7" cy="18" r="4"/><circle cx="27" cy="18" r="4"/></g>
${panel}
<rect x="${W - 12 * credit.length}" y="${H - 34}" width="${12 * credit.length}" height="34" fill="#FFFFFF" fill-opacity="0.85"/><text x="${W - 10}" y="${H - 10}" text-anchor="end" font-family="DejaVu Sans" font-size="19" fill="#333333">${esc(credit)}</text></svg>`;
}

// close: the satellite close-up, for a truck that isn't moving. A JPEG, so the picture stays small next to the trip sheet.
export async function renderTruckMap({ lat, lng, tone = 'blue', big = null, label = null, lines = [], close = false, fetchFn = globalThis.fetch, now = Date.now() }) {
  if (lat == null || lng == null) return null;
  try {
    const layer = close ? LAYERS.close : LAYERS.street;
    const grid = tileGrid(Number(lat), Number(lng), layer.zoom);
    const jobs = layer.tiles.flatMap((src) => grid.map((t) => ({ t, src: src(layer.zoom, t.x, t.y) })));   // base layer first, roads on top
    const tiles = await Promise.all(jobs.map(async ({ t, src }) => ({ ...t, href: await tile(src, fetchFn, now) })));
    const out = new Resvg(mapSvg(tiles, { tone, big, label, lines, credit: layer.credit }), { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' } }).render();
    return Buffer.from(jpeg.encode({ data: out.pixels, width: out.width, height: out.height }, 80).data);
  } catch (e) { console.warn('[truck-map]', e.message); return null; }
}
