import test from 'node:test';
import assert from 'node:assert/strict';
import { findSensitivePairs } from '../dist/audit/duplicates-sensitive.js';
import { findDuplicatePairs } from '../dist/audit/duplicates.js';
const at=(h,m)=>Date.parse(`2026-11-12T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00Z`)/1000;
const a=(id,start,min,sport='Run')=>({id:String(id),start_utc:start,duration_seconds:min*60,sport,distance_m:5000,name:`Activity ${id}`});
test('keeps strict high confidence matches',()=>{
  const x=findSensitivePairs([a(1,at(8,0),45),a(2,at(8,2),44)]);
  assert.equal(x.length,1); assert.equal(x[0].confidence,'high');
});
test('finds short contained runs excluded by strict detector',()=>{
  const x=[a(1,at(8,0),120),a(2,at(8,45),20)];
  assert.equal(findDuplicatePairs(x).length,0);
  assert.equal(findSensitivePairs(x)[0].confidence,'review');
});
test('finds Run versus Workout when recorded concurrently',()=>{
  const x=findSensitivePairs([a(1,at(8,0),45,'Run'),a(2,at(8,2),44,'Workout')]);
  assert.equal(x.length,1); assert.equal(x[0].confidence,'review');
});
test('flags different sports only as review when starts and windows match',()=>{
  const x=findSensitivePairs([a(1,at(8,0),45,'Run'),a(2,at(8,1),46,'Ride')]);
  assert.equal(x.length,1); assert.equal(x[0].confidence,'review');
});
test('does not flag separated strength workouts or consecutive runs',()=>{
  assert.equal(findSensitivePairs([a(1,at(8,0),50,'WeightTraining'),a(2,at(17,0),50,'Workout')]).length,0);
  assert.equal(findSensitivePairs([a(1,at(8,0),30),a(2,at(8,30),30)]).length,0);
});
test('finds slightly offset watch recordings and avoids unrelated cross sport intervals',()=>{
  assert.equal(findSensitivePairs([a(1,at(8,0),25),a(2,at(8,12),42)]).length,1);
  assert.equal(findSensitivePairs([a(1,at(8,0),100,'Run'),a(2,at(8,45),10,'Ride')]).length,0);
});
