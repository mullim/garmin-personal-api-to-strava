import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectFit, inspectXml } from '../dist/formats/fit.js';
import { Store } from '../dist/persistence/store.js';
import { isLikelyDuplicate, duplicateFor, syncRemote, reconcile, migrate } from '../dist/migration/migrate.js';

function definition(local, global, fields) {
  const b = Buffer.alloc(6 + fields.length*3);
  b[0] = 0x40 | local; // definition
  b[1] = 0;
  b[2] = 0; // little endian
  b.writeUInt16LE(global, 3);
  b[5] = fields.length;
  fields.forEach(([num,sz],i) => { b[6+i*3] = num; b[7+i*3] = sz; b[8+i*3] = sz === 1 ? 0x00 : 0x86; });
  return b;
}
function fitFile(isActivity = true, start = 1100000000) {
  const parts = [definition(0, 0, [[0,1]]), Buffer.from([0, isActivity ? 4 : 9])];
  if (isActivity) {
    parts.push(definition(1,18, [[2,4],[7,4],[9,4],[5,1]]));
    const data = Buffer.alloc(1+4+4+4+1);
    data[0] = 1;
    data.writeUInt32LE(start-631065600, 1);
    data.writeUInt32LE(3600000, 5);
    data.writeUInt32LE(500000, 9);
    data[13] = 1;
    parts.push(data);
  }
  const records = Buffer.concat(parts);
  const header = Buffer.alloc(14);
  header[0] = 14; header[1] = 0x20;
  header.writeUInt16LE(100,2);
  header.writeUInt32LE(records.length,4);
  header.write('.FIT',8,'ascii');
  return Buffer.concat([header, records, Buffer.alloc(2)]);
}

function temp() { return mkdtempSync(join(tmpdir(), 'g2s-test-')); }

test('FIT inspector distinguishes workouts from wellness and reads metadata', () => {
  const workout = inspectFit(fitFile(true));
  assert.equal(workout.isActivity,true);
  assert.equal(workout.startUtc,1100000000);
  assert.equal(workout.durationSeconds,3600);
  assert.equal(workout.distanceM,5000);
  assert.equal(workout.sport,'Run');
  assert.equal(inspectFit(fitFile(false)).isActivity,false);
  assert.equal(inspectFit(Buffer.from('not a FIT')),null);
  assert.equal(inspectXml(Buffer.from('<gpx><trk><trkseg><trkpt><time>2024-01-01T10:00:00Z</time></trkpt></trkseg></trk></gpx>'),'gpx').isActivity,true);
});

test('SQLite state persists and exact timing plus plausible metrics matches duplicates', () => {
  const dir = temp();
  try {
    const db = new Store(dir);
    const file = { digest:'sha',path:'/example',originalPath:'example',format:'fit',startUtc:1100000000,durationSeconds:3600,distanceM:5000,sport:'Run' };
    db.addFile(file);
    db.upsertRemote({ id:999,start_date:new Date(1100000000*1000).toISOString(),elapsed_time:3597,distance:4980,sport_type:'Run' });
    assert.equal(duplicateFor(db.files()[0],db).id,'999');
    assert.equal(reconcile(db,()=>{}),1);
    assert.equal(db.files()[0].status,'skipped');
    db.close();
    const reopen = new Store(dir);
    assert.equal(reopen.files()[0].remote_activity_id,'999');
    assert.equal(isLikelyDuplicate(file,{start_utc:1100000000,distance_m:9000,duration_seconds:3600}),false);
    reopen.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('sync is resumable and only marks complete after last page', async () => {
  const dir = temp();
  const store = new Store(dir);
  try {
    const first = Array.from({length:100},(_,i)=>({id:i+1,start_date:'2023-01-01T00:00:00Z'}));
    let seen = [];
    const api = { activities: async page => { seen.push(page); if (page === 2 && seen.length === 2) throw new Error('temporary'); return page===1 ? first : []; } };
    await assert.rejects(syncRemote(store,api,()=>{}),/temporary/);
    assert.equal(store.getMeta('remote_synced_at'),'');
    assert.equal(store.getMeta('remote_sync_next_page'),'2');
    await syncRemote(store,api,()=>{});
    assert.deepEqual(seen,[1,2,2]);
    assert.equal(store.countRemote(),100);
    assert.ok(store.getMeta('remote_synced_at'));
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('migrate persists processing state and does not resubmit a processed upload', async () => {
  const dir = temp();
  const store = new Store(dir);
  try {
    const filePath=join(dir,'test.fit');
    writeFileSync(filePath,fitFile(true));
    store.addFile({digest:'testhash',path:filePath,originalPath:'run.fit',format:'fit',startUtc:1100000000,durationSeconds:3600,distanceM:5000,sport:'Run'});
    store.setMeta('remote_synced_at',new Date().toISOString());
    let uploads=0;
    const fake = { upload: async () => { uploads++; return {id_str:'123'}; },uploadStatus: async()=>({id_str:'123',activity_id:456,error:null,status:'Your activity is ready.'}) };
    await migrate(store,fake,{max:1,log:()=>{}});
    assert.equal(store.files()[0].status,'uploaded');
    assert.equal(store.files()[0].remote_activity_id,'456');
    await migrate(store,fake,{max:1,log:()=>{}});
    assert.equal(uploads,1);
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('network failure on upload is treated as uncertain and never blindly retried', async () => {
  const dir=temp(); const store=new Store(dir);
  try {
    const filePath=join(dir,'x.fit');writeFileSync(filePath,fitFile(true));
    store.addFile({digest:'unknown',path:filePath,originalPath:'x.fit',format:'fit',startUtc:1100000000});
    store.setMeta('remote_synced_at',new Date().toISOString());
    let attempts=0;
    const bad={ upload:async()=>{attempts++;throw new Error('Upload outcome unknown (network failure)');} };
    await assert.rejects(migrate(store,bad,{log:()=>{}}),/outcome uncertain/i);
    assert.equal(store.files()[0].status,'uncertain');
    await migrate(store,bad,{log:()=>{}});
    assert.equal(attempts,1);
  } finally {store.close(); rmSync(dir,{recursive:true,force:true});}
});

test('Strava client sends real multipart FIT bytes and a deterministic external ID', async () => {
  const { StravaClient } = await import('../dist/integrations/strava.js');
  const dir = temp();
  try {
    writeFileSync(join(dir,'token.json'),JSON.stringify({access_token:'test-access',refresh_token:'refresh',expires_at:Math.floor(Date.now()/1000)+3600}));
    const filePath=join(dir,'workout.fit');writeFileSync(filePath,fitFile(true));
    let called = 0;
    const fetchFn = async (url,options) => {
      called++;
      assert.match(url,/\/api\/v3\/uploads$/);
      assert.equal(options.method,'POST');
      assert.equal(options.headers.Authorization,'Bearer test-access');
      assert.equal(options.body.get('data_type'),'fit');
      assert.equal(options.body.get('external_id'),'garmin-migrate-'+'abcdef'.slice(0,32));
      const file = options.body.get('file');
      assert.ok(file instanceof Blob);
      assert.equal(Buffer.compare(Buffer.from(await file.arrayBuffer()),readFileSync(filePath)),0);
      return new Response(JSON.stringify({id_str:'456',error:null}),{status:201,headers:{'X-RateLimit-Limit':'200,2000','X-RateLimit-Usage':'1,10'}});
    };
    const client=new StravaClient(dir,fetchFn);
    const result=await client.upload({digest:'abcdef',format:'fit',path:filePath});
    assert.equal(result.id_str,'456');
    assert.equal(called,1);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
