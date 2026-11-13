import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GarminClient, GarminPause, retryAfterMs, normalizeGarminActivity, jwtExpiresAt } from '../src/garmin.mjs';
import { Store } from '../src/store.mjs';
import { discoverGarmin, cacheGarminDownload, stageGarmin, garminPlan } from '../src/garmin-import.mjs';

const temp = () => mkdtempSync(join(tmpdir(),'g2s-garmin-test-'));
const FUTURE = Math.floor(Date.now()/1000)+90000;
const jwt = 'header.'+Buffer.from(JSON.stringify({exp:FUTURE})).toString('base64url')+'.sig';
function fitFile(start = 1100000000) {
  function def(local,global,fields) {
    const b=Buffer.alloc(6+fields.length*3);
    b[0]=0x40|local;b.writeUInt16LE(global,3);b[5]=fields.length;
    fields.forEach(([num,size],i)=>{b[6+i*3]=num;b[7+i*3]=size;b[8+i*3]=0x86;});
    return b;
  }
  const record=Buffer.alloc(14);
  record[0]=1;
  record.writeUInt32LE(start-631065600,1);
  record.writeUInt32LE(1200000,5);
  record.writeUInt32LE(400000,9);
  record[13]=1;
  const body=Buffer.concat([def(0,0,[[0,1]]),Buffer.from([0,4]),def(1,18,[[2,4],[7,4],[9,4],[5,1]]),record]);
  const header=Buffer.alloc(14);
  header[0]=14;header[1]=0x20;header.writeUInt32LE(body.length,4);header.write('.FIT',8);
  return Buffer.concat([header,body,Buffer.alloc(2)]);
}
function zippedFit(root) {
  mkdirSync(join(root,'work'));
  writeFileSync(join(root,'work','run.fit'),fitFile());
  writeFileSync(join(root,'work','run.gpx'),'<gpx><trk><trkseg><trkpt><time>2004-11-09T00:00:00Z</time></trkpt></trkseg></trk></gpx>');
  execFileSync('zip',['-q',join(root,'activity.zip'),'run.fit','run.gpx'],{cwd:join(root,'work')});
  return readFileSync(join(root,'activity.zip'));
}

test('Garmin token endpoint uses ApiKey, receives raw JWT, and requests official endpoints',async()=>{
  const d=temp(); const previous=process.env.GARMIN_PERSONAL_API_KEY;
  try {
    process.env.GARMIN_PERSONAL_API_KEY='test-key';
    let calls=[];
    const fetchFn=async (url,options)=>{
      calls.push({url,options});
      if(url.includes('personal-api-key/token')) {
        assert.equal(options.method,'POST');
        assert.equal(options.headers.Authorization,'ApiKey test-key');
        return new Response(jwt);
      }
      assert.equal(options.headers.Authorization,`Bearer ${jwt}`);
      assert.match(url,/activities\/search\/activities\?start=0&limit=20/);
      return new Response(JSON.stringify([{activityId:123,activityName:'Run',startTimeGMT:'2024-01-02 13:00:00',duration:1250,distance:5000,activityType:{typeKey:'running'}}]));
    };
    const api = new GarminClient(d,fetchFn,{minIntervalMs:0});
    const rows = await api.activities();
    assert.equal(calls.length,2);
    assert.equal(rows[0].startUtc,Date.parse('2024-01-02T13:00:00Z')/1000);
    assert.equal(rows[0].durationSeconds,1250);
    assert.equal(rows[0].distanceM,5000);
    assert.equal(jwtExpiresAt(jwt),FUTURE);
    await api.activities();
    assert.equal(calls.length,3,'token should come from 0600 cache');
  } finally { previous == null ? delete process.env.GARMIN_PERSONAL_API_KEY : process.env.GARMIN_PERSONAL_API_KEY=previous; rmSync(d,{recursive:true,force:true}); }
});

test('Garmin discovery paginates and resumes failed page without completing inventory early',async()=>{
  const d=temp();const store=new Store(d);
  const first=Array.from({length:20},(_,i)=>({id:String(i+1),name:`Activity ${i+1}`,startUtc:1100000000+i*86400,durationSeconds:1200,distanceM:4000,sport:'run'}));
  const seen=[];
  const mock={activities:async(offset)=>{seen.push(offset);if(offset===20&&seen.length===2)throw new Error('connection lost');return offset===0?first:[{id:'21',name:'Last',startUtc:1100000000+21*86400}];}};
  try {
    await assert.rejects(discoverGarmin(store,mock,()=>{}),/connection lost/);
    assert.equal(store.countGarmin(),20);
    assert.equal(store.getMeta('garmin_next_offset'),'20');
    assert.equal(store.getMeta('garmin_discovered_at'),'');
    await discoverGarmin(store,mock,()=>{});
    assert.deepEqual(seen,[0,20,20]);
    assert.equal(store.countGarmin(),21);
    assert.ok(store.getMeta('garmin_discovered_at'));
    store.close();
    const reopened=new Store(d);
    assert.equal(reopened.countGarmin(),21);
    reopened.close();
  } finally { try{store.close();}catch{} rmSync(d,{recursive:true,force:true}); }
});

test('original per-activity Garmin ZIP is filtered to one original FIT, never both FIT and GPX',async()=>{
  const d=temp();const store=new Store(join(d,'state'));
  try {
    store.addGarmin({id:'42',name:'run',startUtc:1100000000,durationSeconds:1200,distanceM:4000,sport:'Run'});
    const bytes=zippedFit(d);
    const digest=await cacheGarminDownload('42',bytes,store);
    assert.equal(store.files().length,1);
    assert.equal(store.files()[0].format,'fit');
    assert.equal(store.files()[0].digest,digest);
    assert.equal(store.garminRows()[0].file_digest,digest);
    assert.equal(garminPlan(store).counts.staged,1);
  } finally{store.close();rmSync(d,{recursive:true,force:true});}
});

test('only Garmin activities not already on Strava get downloaded',async()=>{
  const d=temp();const store=new Store(join(d,'state'));
  try {
    store.addGarmin({id:'1',name:'already present',startUtc:1100000000,durationSeconds:1200,distanceM:4000,sport:'Run'});
    store.addGarmin({id:'2',name:'new',startUtc:1150000000,durationSeconds:1200,distanceM:4000,sport:'Run'});
    store.upsertRemote({id:'strava1',start_date:new Date(1100000000*1000).toISOString(),elapsed_time:1200,distance:4000});
    store.setMeta('remote_synced_at',new Date().toISOString());
    const archive=zippedFit(d);
    let downloaded=[];
    const mock={downloadActivity:async(id)=>{downloaded.push(id);return archive;}};
    const result=await stageGarmin(store,mock,{max:3,log:()=>{}});
    assert.deepEqual(downloaded,['2']);
    assert.equal(result.skipped,1);
    assert.equal(store.files().length,1);
    assert.equal(store.garminRows().find(x=>x.id==='1').state,'skipped');
  } finally{store.close();rmSync(d,{recursive:true,force:true});}
});

test('Garmin activity parsing rejects missing IDs and treats startTimeGMT as UTC',()=>{
  assert.throws(()=>normalizeGarminActivity({activityName:'no id'}),/activityId/);
  assert.equal(normalizeGarminActivity({activityId:1,startTimeGMT:'2026-01-02 03:04:05'}).startUtc,Date.parse('2026-01-02T03:04:05Z')/1000);
});

test('end-to-end mocked Garmin download and Strava import is resumable without resending',async()=>{
  const { runGarminMigration } = await import('../src/garmin-import.mjs');
  const d=temp(); const store=new Store(join(d,'state'));
  try {
    store.addGarmin({id:'111',name:'Workout',startUtc:1100000000,durationSeconds:1200,distanceM:4000,sport:'Run'});
    store.setMeta('remote_synced_at',new Date().toISOString());
    const archive=zippedFit(d);
    let downloads=0,uploads=0;
    const garmin={downloadActivity:async()=>{downloads++;return archive;}};
    const strava={upload:async file=>{uploads++;assert.equal(file.format,'fit');return {id_str:'u123'};},uploadStatus:async()=>({id_str:'u123',activity_id:9876,status:'Your activity is ready'})};
    await runGarminMigration(store,garmin,strava,{max:1,log:()=>{}});
    assert.equal(store.files()[0].status,'uploaded');
    assert.equal(garminPlan(store).counts.uploaded,1);
    await runGarminMigration(store,garmin,strava,{max:1,log:()=>{}});
    assert.equal(downloads,1);
    assert.equal(uploads,1);
  } finally {store.close();rmSync(d,{recursive:true,force:true});}
});


test('Garmin HTTP 429 honors Retry-After and cooldown survives a new client instance', async () => {
  const d = temp();
  const prior = process.env.GARMIN_PERSONAL_API_KEY;
  let requests = 0;
  try {
    process.env.GARMIN_PERSONAL_API_KEY = 'test-key';
    const fake = async (url) => {
      requests++;
      if (url.includes('personal-api-key/token')) return new Response(jwt);
      return new Response('throttled', {status:429, headers:{'Retry-After':'120'}});
    };
    const client = new GarminClient(d, fake, {minIntervalMs:0});
    await assert.rejects(client.activities(), err => {
      assert.ok(err instanceof GarminPause);
      assert.match(err.message, /Retry-After header/);
      assert.ok(err.retryAt >= Date.now() + 115_000);
      return true;
    });
    assert.equal(requests, 2);
    const newer = new GarminClient(d, fake, {minIntervalMs:0});
    await assert.rejects(newer.activities(), /cooldown active/);
    assert.equal(requests, 2, 'cooldown must block further requests locally');
    const saved = JSON.parse(readFileSync(join(d, 'garmin-cooldown.json'), 'utf8'));
    assert.equal(saved.strikes, 1);
    assert.ok(saved.until > Date.now());
    assert.equal(retryAfterMs('15'), 15_000);
    assert.equal(retryAfterMs('bogus'), null);
  } finally {
    prior == null ? delete process.env.GARMIN_PERSONAL_API_KEY : process.env.GARMIN_PERSONAL_API_KEY = prior;
    rmSync(d, {recursive:true,force:true});
  }
});

test('Garmin HTTP 429 without Retry-After uses explicit conservative fallback', async () => {
  const d = temp();
  const previous = process.env.GARMIN_PERSONAL_API_KEY;
  try {
    process.env.GARMIN_PERSONAL_API_KEY='test-key';
    const api = new GarminClient(d, async (url) => url.includes('personal-api-key/token')
      ? new Response(jwt)
      : new Response('throttled', {status:429}), {minIntervalMs:0});
    await assert.rejects(api.activities(), /conservative fallback/);
    const json=JSON.parse(readFileSync(join(d,'garmin-cooldown.json'),'utf8'));
    assert.ok(json.until - Date.now() > 29 * 60 * 1000);
  } finally {
    previous == null ? delete process.env.GARMIN_PERSONAL_API_KEY : process.env.GARMIN_PERSONAL_API_KEY=previous;
    rmSync(d,{recursive:true,force:true});
  }
});

test('Garmin throttle after a download does not discard previously uploaded progress', async()=>{
  const {runGarminMigration} = await import('../src/garmin-import.mjs');
  const d=temp(); const store=new Store(join(d,'state'));
  try {
    store.addGarmin({id:'20',name:'Run A',startUtc:1100000000,durationSeconds:1200,distanceM:4000,sport:'Run'});
    store.addGarmin({id:'21',name:'Run B',startUtc:1150000000,durationSeconds:1200,distanceM:4000,sport:'Run'});
    store.setMeta('remote_synced_at',new Date().toISOString());
    const archive=zippedFit(d);
    const downloaded=[];
    const garmin={downloadActivity:async id=>{
      downloaded.push(id);
      if(id==='21') throw new GarminPause('Garmin returned HTTP 429.',Date.now()+60_000);
      return archive;
    }};
    const strava={upload:async()=>({id_str:'u100'}),uploadStatus:async()=>({activity_id:101,status:'Your activity is ready'})};
    await assert.rejects(runGarminMigration(store,garmin,strava,{max:2,log:()=>{}}),/429/);
    assert.deepEqual(downloaded,['20','21']);
    assert.equal(store.files()[0].status,'uploaded', 'first upload must finish before next Garmin download');
  } finally {store.close();rmSync(d,{recursive:true,force:true});}
});
