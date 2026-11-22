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
