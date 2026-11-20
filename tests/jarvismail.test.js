import test from 'node:test';
import assert from 'node:assert/strict';
import { esc, safeUrl, telHref, mapUrl, cityState, isSpanish, jarvisEmail, facts, fileBox, location } from '../jarvismail.js';

test('jarvis email: escaping, only http(s) links, tel and map links from real values, Spanish detection, city names', () => {
  assert.equal(esc('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(safeUrl('javascript:alert(1)'), null); assert.equal(safeUrl('https://x/a b'), null); assert.equal(safeUrl('https://x/bk/f/abc'), 'https://x/bk/f/abc');
  assert.equal(telHref('786-314-2671'), 'tel:+17863142671'); assert.equal(telHref('12'), null);
  assert.equal(mapUrl(27.44672, -80.32561), 'https://maps.google.com/?q=27.44672,-80.32561'); assert.equal(mapUrl(null, 3), null); assert.equal(mapUrl(200, 0), null);
  assert.equal(cityState('SOUTH WINDSOR, CT'), 'South Windsor, CT');
  assert.equal(isSpanish('Faltan 2 cajas de rosas.'), true); assert.equal(isSpanish('Tire blew out on I-95'), false);
  const f = fileBox('Photo 1', 'Attached', 'javascript:alert(1)');
  assert.doesNotMatch(f, /javascript:/, 'a bad link is dropped, the name stays');
  assert.match(location({}), /No location was sent/); assert.doesNotMatch(location({}), /maps\.google/);
});

test('jarvis email: tables and inline styles (no flex / grid / script / iframe), 640 wide, header, signature J, preheader, test notice only when asked', () => {
  const html = jarvisEmail({ preheader: 'Pre <x>', eyebrow: 'VEHICLE STOPPED', title: 'Tire <b>', subtitle: 'Trailer 1', meta: ['BK-1', 'Nov 19, 4:43 PM ET'], lead: 'Do this', body: facts([['A', 'B']]) });
  assert.doesNotMatch(html, /display:\s*(flex|grid)|<script|<iframe|<form/i);
  assert.match(html, /max-width:640px/); assert.match(html, /FLORIDA BEAUTY FLORA/); assert.match(html, /JARVIS \/ OPERATIONS UPDATE/);
  assert.match(html, />J<\/td>/); assert.match(html, /AI Dispatcher/); assert.match(html, /Pre &lt;x&gt;/); assert.match(html, /Tire &lt;b&gt;/);
  assert.doesNotMatch(html, /TEST · SAMPLE DATA/);
  assert.match(jarvisEmail({ test: true, eyebrow: 'X', title: 'Y' }), /TEST · SAMPLE DATA · NOT A REAL REPORT/);
});
