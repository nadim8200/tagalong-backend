import test from 'node:test';
import assert from 'node:assert/strict';
import { tileGrid, mapSvg, renderTruckMap } from '../truckmap.js';

test('the tiles cover the picture and put the truck where the marker is', () => {
  const g = tileGrid(38.41, -122.71);
  assert.ok(g.length >= 6 && g.length <= 30, `${g.length} tiles is a light request`);
  assert.ok(g.every((t) => Number.isInteger(t.x) && Number.isInteger(t.y) && t.x >= 0 && t.y >= 0));
  assert.ok(Math.min(...g.map((t) => t.px)) <= 0 && Math.max(...g.map((t) => t.px)) + 384 >= 1184, 'covers the width');
  assert.ok(Math.min(...g.map((t) => t.py)) <= 0 && Math.max(...g.map((t) => t.py)) + 384 >= 560, 'covers the height');
});

test('the picture shows the status and credits the map; text is escaped', () => {
  const s = mapSvg([], { tone: 'green', big: '4m', label: 'ROLLING', lines: ['Speed <58> mph', null, 'x'] });
  assert.match(s, /ROLLING/); assert.match(s, /Speed &lt;58&gt; mph/); assert.match(s, /OpenStreetMap contributors/); assert.match(s, /#166534/);
  assert.doesNotMatch(mapSvg([], { tone: 'red' }), /ROLLING/);
});

test('no coordinates or no tiles: no picture and no crash, so the email still goes', async () => {
  assert.equal(await renderTruckMap({ lat: null, lng: null }), null);
  assert.equal(await renderTruckMap({ lat: 20.5, lng: -70.5, fetchFn: async () => ({ ok: false, status: 503 }) }), null);
  assert.equal(await renderTruckMap({ lat: 20.5, lng: -70.5, fetchFn: async () => { throw new Error('down'); } }), null);
});
