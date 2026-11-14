import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickupEmail, variant, hasPlan } from '../pickupmail.js';

const base = { trip: '626430', truck: '4550', trailer: '7371', driver: 'Frank U', subject: 'S', plan: { ms: Date.parse('2026-11-14T19:00:00Z'), place: 'Orlando, FL', tz: null, source: 'rate con' }, live: { location: 'I-75 N, Ocala, FL', gpsAt: '2026-11-14T19:05:00Z', speedMph: 0, lat: 29.18, lng: -82.14 } };

test('pickup update: amber "not yet" keeps the driver\'s words (escaped), marks a time plan as not verified; green says only what the driver confirmed', () => {
  const no = pickupEmail({ ...base, outcome: { status: 'not_rolling', source: 'driver app', driverSaid: 'On my reset <b>, rolling at 6 PM' } });
  assert.match(no.html, /DRIVER RESPONSE · NOT YET/); assert.match(no.html, /Not yet heading to pickup/); assert.match(no.html, /Driver’s explanation/);
  assert.match(no.html, /On my reset &lt;b&gt;, rolling at 6 PM/); assert.match(no.html, /Driver-reported plan · Not a verified ETA/);
  assert.match(no.html, /Stopped/); assert.match(no.html, /As of Sat, Nov 14 · 2:05 PM ET/); assert.match(no.html, /Time zone not provided/); assert.match(no.html, /From rate confirmation/);
  assert.match(no.html, /View truck on map/); assert.match(no.html, /JARVIS · PICKUP UPDATE/); assert.match(no.html, /cid:pk-jarvis-avatar/);
  assert.match(pickupEmail({ ...base, outcome: { status: 'not_rolling', source: 'driver app' } }).html, /No explanation provided\./);
  const yes = pickupEmail({ ...base, live: { ...base.live, speedMph: 58 }, outcome: { status: 'rolling', source: 'driver app' } });
  assert.match(yes.html, /DRIVER RESPONSE · YES/); assert.match(yes.html, /Confirmed in the driver app/); assert.match(yes.html, /Frank U confirmed they are heading to pickup\./);
  assert.match(yes.html, /Moving · 58 mph/); assert.doesNotMatch(yes.html, /on time/i);
  assert.equal(variant({ status: 'rolling', source: 'TruckMate: departed the shipper' }).badge, 'PICKUP STATUS', 'not a driver response');
  const bare = pickupEmail({ ...base, truck: null, plan: null, live: {}, outcome: { status: 'not_rolling', source: 'driver app' } });
  assert.match(bare.html, />Not available</); assert.match(bare.html, /No GPS time available/);
  assert.match(no.text, /^DRIVER RESPONSE · NOT YET\nNot yet heading to pickup\nFrank U · Trip 626430/);
  const hosted = pickupEmail({ ...base, outcome: { status: 'rolling', source: 'driver app' }, images: 'https://x.test' });
  assert.match(hosted.html, /https:\/\/x\.test\/email\/img\/flower-mark\.png/); assert.equal(hosted.attachments.length, 0);
  assert.equal(hasPlan('waiting on the reefer'), false); assert.equal(hasPlan('rolling at 6 PM'), true);
});

test('the driver\'s actual reply is always in the email: their text word for word, or what they tapped in the app, with the time', () => {
  const t = pickupEmail({ ...base, outcome: { status: 'rolling', source: 'driver text', driverSaid: 'Rolling now, 20 min out', at: '2026-11-14T18:40:00Z' } });
  assert.match(t.html, /Driver’s reply/); assert.match(t.html, /&ldquo;Rolling now, 20 min out&rdquo;/); assert.match(t.html, /Answered Sat, Nov 14 · 1:40 PM ET/);
  assert.match(t.text, /Driver's reply: "Rolling now, 20 min out"/);
  const app = pickupEmail({ ...base, outcome: { status: 'rolling', source: 'driver app', at: '2026-11-14T18:40:00Z' } });
  assert.match(app.html, /Tapped &ldquo;Yes, I’m rolling&rdquo; in the driver app \(no comment\)/);
  const no = pickupEmail({ ...base, outcome: { status: 'not_rolling', source: 'driver app', driverSaid: 'Reefer down', at: '2026-11-14T18:40:00Z' } });
  assert.match(no.html, /&ldquo;Reefer down&rdquo;/); assert.match(no.html, /Answered Sat, Nov 14/);
});
