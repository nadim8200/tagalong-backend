import { test } from 'node:test';
import assert from 'node:assert/strict';
import { yardForCity } from '../flzones.js';

test('Florida yard zones: Central Florida from Elkton to Fort Myers; Miami from Naples down and up the east coast through West Palm (Nov 18)', () => {
  const want = {
    'WINTER HAVEN, FL': 'BARTOW', 'LAKELAND, FL': 'BARTOW', 'ELKTON, FL': 'BARTOW', 'FORT MYERS, FL': 'BARTOW', 'FT MYERS, FL 33901': 'BARTOW', 'CAPE CORAL': 'BARTOW',
    'TAMPA, FL': 'BARTOW', 'SARASOTA': 'BARTOW', 'ORLANDO, FL': 'BARTOW', 'PORT SAINT LUCIE, FL': 'BARTOW', 'JUPITER, FL': 'BARTOW', 'PALM BEACH GARDENS': 'BARTOW',
    'PALMETTO, FL': 'BARTOW', 'LARGO, FL': 'BARTOW', 'PIERSON, FL': 'BARTOW', 'CLEWISTON, FL': 'BARTOW',
    'NAPLES, FL': 'MIAMI', 'KEY LARGO, FL': 'MIAMI', 'KEY WEST': 'MIAMI', 'PALMETTO BAY, FL': 'MIAMI', 'HOMESTEAD': 'MIAMI', 'MIAMI, FL 33122': 'MIAMI', 'HIALEAH': 'MIAMI',
    'POMPANO BEACH, FL': 'MIAMI', 'OAKLAND PARK, FL': 'MIAMI', 'BOCA RATON': 'MIAMI', 'WEST PALM BEACH, FL': 'MIAMI', 'RIVIERA BEACH, FL': 'MIAMI', 'DFB, FL': 'MIAMI',
    'JACKSONVILLE, FL': null, 'MACCLENNY, FL': null, 'ATLANTA, GA': null, '': null,
  };
  for (const [c, y] of Object.entries(want)) assert.equal(yardForCity(c), y, c);
});
