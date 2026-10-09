import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadClientFile, clientIndex, billIsClient } from '../clients.js';
import { nameScore } from '../voice.js';
import { whoIs } from '../activity.js';

const list = loadClientFile();
const idx = clientIndex(list, { score: nameScore });

test('the client list is loaded and clean', () => {
  assert.ok(list.length > 1700);
  const d = idx.byId('00983');
  assert.deepEqual([d.name, d.city, d.state, d.zip, d.phone, d.fax, d.emails[0]], ['D.B.E.C. WHOLESALE', 'GREENSBURG', 'PA', '15601', '7248346200', '7248346216', 'dbecwholesale1@yahoo.com']);
  assert.equal(idx.byId('01866').emails[0], 'accounting@eastcoastwholesaleflowers.com', 'wrapped e-mail joined');
  assert.equal(idx.byId('00444').name, 'SUNBELT WHOLESALE FLORISTS', 'long name not cut');
  assert.equal(list.filter((c) => !c.name).length, 0);
});

test('recognize by phone, email, spoken name (+ town)', () => {
  assert.equal(idx.byPhone('724.834.6200').id, '00983');
  assert.equal(idx.byPhone('+1 (724) 834-6216').id, '00983', 'fax counts');
  assert.equal(idx.byEmail('DBECWHOLESALE1@YAHOO.COM').id, '00983');
  assert.equal(idx.byName('D B E C wholesale')[0].id, '00983');
  assert.equal(idx.byName('Sunbelt Wholesale Florist')[0].id, '00444');
  assert.deepEqual(idx.byName('Wholesale'), [], 'a generic word alone is nobody');
  assert.equal(idx.byName('R and W Wholesale')[0].id, '03469', 'initials are the name');
  assert.equal(idx.byName('J & J Wholesale Florist')[0].id, idx.byName('J and J wholesale florist')[0].id);
});

test('a bill is the client\'s by client ID, name or consignee phone', () => {
  const c = idx.byId('00983');
  assert.equal(billIsClient({ billToName: 'X', consignee: { clientId: '983' } }, c, nameScore), true);
  assert.equal(billIsClient({ billToName: 'D.B.E.C. WHOLESALE' }, c, nameScore), true);
  assert.equal(billIsClient({ billToName: 'X', consignee: { name: 'Y', phone: '724-834-6200' } }, c, nameScore), true);
  assert.equal(billIsClient({ billToName: 'RICCARDI WHOLESALE' }, c, nameScore), false);
});

test('Calls & texts: an unknown number on the client list shows the business', () => {
  assert.deepEqual(whoIs('7248346200', { clients: idx }), { role: 'customer', name: 'D.B.E.C. WHOLESALE', detail: 'GREENSBURG, PA' });
});
