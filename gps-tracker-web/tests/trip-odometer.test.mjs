import test from 'node:test';
import assert from 'node:assert/strict';
import {validateOdometerInput, odometerSummary} from '../src/lib/tripOdometer.js';

test('missing odometer readings remain unknown and measured zero remains zero',()=>{
  assert.deepEqual(validateOdometerInput('',' ').payload,{odometer_before_km:null,odometer_after_km:null});
  const zero=validateOdometerInput('0','0');
  assert.equal(zero.error,'');assert.equal(zero.distanceKm,0);
  assert.deepEqual(zero.payload,{odometer_before_km:0,odometer_after_km:0});
  assert.match(odometerSummary(zero.payload),/0 → 0 km/);
});

test('invalid, partial, negative, out of range, reversed and overprecision readings are rejected',()=>{
  for(const [before,after] of [['','2'],['2',''],['-1','0'],['2','1'],['1','1.001'],['0','10000000'],['NaN','2'],['1','Infinity'],['1e2','200'],['1km','2'],['1,000','2000']]) {
    assert.ok(validateOdometerInput(before,after).error,`${before} → ${after}`);
  }
  const value=validateOdometerInput('9999999.98','9999999.99');
  assert.equal(value.error,'');assert.equal(value.distanceKm,0.01);
  assert.match(odometerSummary({odometer_before_km:20,odometer_after_km:10}),/확인 필요/);
});
