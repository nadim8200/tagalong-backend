import test from 'node:test';
import assert from 'node:assert/strict';
import { profanity } from '../profanity.js';

test('a normal dispatch question is clean (numbers, places, times)', () => {
  for (const q of ['What door are you at in Perryville?', 'Are you loaded? Trip 627662, ETA to Elkton by 8 AM?', '¿Ya descargaste en Miami? ¿Cuántas cajas faltan?', 'Check the reefer is at -10°F and send a photo', 'Is the assistant at the dock?'])
    assert.deepEqual(profanity(q), [], q);
});
test('swear words and slurs are caught — English, Spanish, spelled with symbols or stretched', () => {
  assert.deepEqual(profanity('where the fuck are you'), ['fuck']);
  assert.ok(profanity('f*ck, call me').length);
  assert.ok(profanity('this is bullsh1t').length);
  assert.ok(profanity('fuuuuck').length);
  assert.ok(profanity('dónde estás pendejo').length);
  assert.ok(profanity('qué mierda pasó').length);
  assert.ok(profanity('Hijo de puta').length);
  assert.ok(profanity('CABRÓN contesta').length);
});

test('"damn" is allowed (Nov 22, Nadim) — "goddamn" is not', () => {
  assert.deepEqual(profanity('damn traffic, what is your ETA?'), []);
  assert.ok(profanity('goddamn it').length);
});

import { NO_MONEY } from '../moneyrule.js';
import { PROMPT } from '../voice.js';
import { CUSTOMER_SYSTEM } from '../jarvischat.js';
test('never money with drivers, customers or brokers — on calls and in email answers (Nov 22)', () => {
  assert.match(NO_MONEY, /no pay, rates/);
  assert.ok(PROMPT.includes(NO_MONEY), 'phone calls');
  assert.ok(CUSTOMER_SYSTEM('Native Chicago').includes(NO_MONEY), 'email answers');
});
test('…but everything else about the load is open: pickup numbers, where it goes, appointments, instructions', () => {
  assert.match(NO_MONEY, /pickup and reference numbers, where it picks up and delivers, addresses, appointment times, special and delivery instructions/);
});
