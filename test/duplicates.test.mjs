import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {findDuplicatePairs,evaluatePair,toCsv,decodePolyline,routeAgreement,saveDuplicateReport} from '../dist/audit/duplicates.js';

const at=(h,m)=>Math.floor(Date.parse(`2026-11-12T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00Z`)/1000);
const act=(id,start,duration,sport='Run',dist=5000,extra={})=>({id:String(id),start_utc:start,duration_seconds:duration*60,sport,distance_m:dist,name:`Workout ${id}`,...extra});

test('two watches running at near-identical times with different distance are high-confidence',()=>{
  const result=evaluatePair(act('101',at(8,0),45,'Run',8030),act('102',at(8,2),46,'TrailRun',8220));
  assert.equal(result.confidence,'high');
  assert.equal(result.metrics.startDeltaSeconds,120);
  assert.ok(result.metrics.overlapOfUnion>.85);
});
test('separate same-day strength sessions do not match',()=>{
  assert.equal(findDuplicatePairs([act('1',at(7,0),45,'WeightTraining',0),act('2',at(18,0),50,'Workout',0)]).length,0);
});
test('two simultaneous strength workouts with no GPS or distance are high-confidence',()=>{
  const hits=findDuplicatePairs([act('1',at(8,0),50,'WeightTraining',0),act('2',at(8,3),48,'Workout',0)]);
  assert.equal(hits.length,1);assert.equal(hits[0].confidence,'high');
});
test('consecutive same-sport sessions do not match',()=>{
  assert.equal(findDuplicatePairs([act('1',at(8,0),30),act('2',at(8,30),30)]).length,0);
});
test('catches cross-midnight overlap',()=>{
  const a=Date.parse('2026-11-12T23:50:00Z')/1000;
  const b=Date.parse('2026-11-13T00:02:00Z')/1000;
  assert.equal(findDuplicatePairs([act('1',a,50),act('2',b,49)]).length,1);
});
test('different sports do not match even when concurrent',()=>{
  assert.equal(findDuplicatePairs([act('1',at(8,0),60,'Run'),act('2',at(8,0),60,'Ride')]).length,0);
});
test('same route repeated at different times is not a duplicate',()=>{
  const poly='_p~iF~ps|U_ulLnnqC_mqNvxq`@';
  assert.equal(findDuplicatePairs([act('1',at(8,0),40,'Run',5000,{route_polyline:poly}),act('2',at(18,0),42,'Run',5000,{route_polyline:poly})]).length,0);
});
test('polyline decoding and spatial agreement, including invalid strings',()=>{
  const poly='_p~iF~ps|U_ulLnnqC_mqNvxq`@';
  assert.equal(decodePolyline(poly).length,3);
  assert.equal(routeAgreement(poly,poly),1);
  assert.equal(routeAgreement('bad',poly),null);
});
test('short contained run inside 2h long run is not reported',()=>{
  assert.equal(findDuplicatePairs([act('1',at(8,0),120),act('2',at(8,5),20)]).length,0);
});
test('overlap with very different GPS distance remains reviewable, not silently rejected',()=>{
  const hits=findDuplicatePairs([act('1',at(8,0),50,'Run',5000),act('2',at(8,4),50,'Run',10000)]);
  assert.equal(hits.length,1);
  assert.notEqual(hits[0].confidence,'high');
});
test('invalid or missing time, category or duration stays out of reports',()=>{
  assert.equal(findDuplicatePairs([act('1',null,50),act('2',at(8,0),0),act('3',at(8,0),50)]).length,0);
});
test('confidence filtering and stable sorted results',()=>{
  const x=[act('1',at(8,0),40),act('2',at(8,1),41),act('3',at(8,20),30)];
  assert.ok(findDuplicatePairs(x).length>=1);
  assert.ok(findDuplicatePairs(x,{minConfidence:'high'}).every(p=>p.confidence==='high'));
});
test('CSV properly quotes commas and quotes and report writes CSV and JSON',()=>{
  const pairs=findDuplicatePairs([act('1',at(8,0),40,'Run',5000,{name:'Run, "Apple"'}),act('2',at(8,2),41)]);
  assert.ok(toCsv(pairs).includes('"Run, ""Apple"""'));
  const d=mkdtempSync(join(tmpdir(),'g2s-duplicate-test-'));
  try {
    const paths=saveDuplicateReport({home:d,getMeta:()=>new Date().toISOString(),countRemote:()=>2},pairs,{log:()=>{}});
    assert.equal(JSON.parse(readFileSync(paths.jsonPath,'utf8')).pairCount,1);
    assert.match(readFileSync(paths.csvPath,'utf8'),/strava\.com\/activities/);
  }finally{rmSync(d,{recursive:true,force:true});}
});

test('deep enrichment fetches only flagged IDs, caches detail, and respects limits',async()=>{
  const {enrichCandidateDetails}=await import('../dist/audit/duplicates.js');
  const pairs=findDuplicatePairs([
    act('1',at(8,0),45,'Run',5000),act('2',at(8,1),45,'Run',5020),
    act('3',at(18,0),40,'Run',5000)
  ]);
  assert.equal(pairs.length,1);
  const rows=new Map([['1',{id:'1'}],['2',{id:'2'}]]);
  const fetched=[];
  const store={remoteById:id=>rows.get(id),updateRemoteDetail:(id,detail)=>rows.set(id,{...rows.get(id),device_name:detail.device_name,detail_fetched_at:'now'})};
  const client={activityDetail:async id=>{fetched.push(id);return {device_name:'Apple Watch'}}};
  const a=await enrichCandidateDetails(store,client,pairs,{max:1,log:()=>{}});
  assert.equal(a.fetched,1);assert.deepEqual(fetched,['1']);
  const b=await enrichCandidateDetails(store,client,pairs,{max:10,log:()=>{}});
  assert.equal(b.cached,1);assert.equal(b.fetched,1);assert.deepEqual(fetched,['1','2']);
});

test('deep enrichment stops cleanly on Strava read budget',async()=>{
  const {enrichCandidateDetails}=await import('../dist/audit/duplicates.js');
  const pairs=findDuplicatePairs([act('1',at(8,0),40),act('2',at(8,1),40)]);
  const result=await enrichCandidateDetails({remoteById:()=>null}, {activityDetail:async()=>{const e=new Error('rate limit');e.name='RateLimitPause';throw e;}},pairs,{log:()=>{}});
  assert.equal(result.rateLimited,true);
  assert.equal(result.fetched,0);
});
