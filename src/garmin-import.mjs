import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipEntries, extractEntry } from './zip.mjs';
import { inspectFit, inspectXml } from './fit.mjs';
import { duplicateFor, reconcile, migrate } from './migrate.mjs';

const MAX_FILE = 64 * 1024 * 1024;
const PAGE_SIZE = 20;

// Don't re-enumerate all historical workouts unless explicitly requested;
// any interrupted enumeration is continued from the last completed page.
export async function discoverGarmin(store, client, log = console.log, force = false) {
  if (!force && store.getMeta('garmin_discovered_at')) {
    log(`Using Garmin index: ${store.countGarmin()} activities. Use --refresh-garmin to rescan Garmin.`);
    return;
  }
  let start = force ? 0 : Number(store.getMeta('garmin_next_offset') || 0);
  if (!Number.isSafeInteger(start) || start < 0) start = 0;
  store.setMeta('garmin_discovered_at', '');
  log(`Discovering Garmin activity history from offset ${start}...`);
  for (; start < 100000; start += PAGE_SIZE) {
    store.setMeta('garmin_next_offset', start);
    const activities = await client.activities(start, PAGE_SIZE);
    if (!Array.isArray(activities)) throw new Error('Invalid Garmin activity response');
    for (const a of activities) store.addGarmin(a);
    store.setMeta('garmin_next_offset', start + PAGE_SIZE);
    if (activities.length < PAGE_SIZE) {
      store.setMeta('garmin_discovered_at', new Date().toISOString());
      store.setMeta('garmin_next_offset', 0);
      log(`Garmin discovery complete: ${store.countGarmin()} historical activities indexed.`);
      return;
    }
    if ((start / PAGE_SIZE + 1) % 5 === 0) log(`  Indexed ${store.countGarmin()} Garmin activities...`);
  }
  throw new Error('Reached Garmin discovery safety limit (100,000 offsets).');
}

export async function cacheGarminDownload(id, zippedBytes, store) {
  const tmp = mkdtempSync(join(tmpdir(), 'g2s-garmin-'));
  const archive = join(tmp, 'activity.zip');
  try {
    writeFileSync(archive, zippedBytes, {mode:0o600});
    const entries = zipEntries(archive).filter(name => /\.(fit|tcx|gpx)$/i.test(name));
    // The endpoint is a per-activity ZIP. Prefer the native FIT over alternate
    // representations; NEVER enqueue all representations of the same activity.
    for (const extension of ['.fit','.tcx','.gpx']) {
      const candidates = entries.filter(name => name.toLowerCase().endsWith(extension));
      const valid = [];
      for (const entry of candidates) {
        const bytes = await extractEntry(archive, entry, null, MAX_FILE);
        const metadata = extension === '.fit' ? inspectFit(bytes) : inspectXml(bytes, extension.slice(1));
        if (metadata?.isActivity) valid.push({ entry, bytes, metadata, extension });
      }
      if (!valid.length) continue;
      if (valid.length > 1) throw new Error(`Garmin activity ${id} download had multiple valid ${extension} workouts; refusing ambiguous import.`);
      const { entry, bytes, metadata } = valid[0];
      const format = extension.slice(1);
      const digest = createHash('sha256').update(bytes).digest('hex');
      const destination = join(store.home, 'activities', `${digest}.${format}`);
      if (!existsSync(destination)) writeFileSync(destination, bytes, { mode: 0o600 });
      store.addFile({
        digest, path:destination, originalPath:`Garmin #${id}: ${entry}`, format, ...metadata,
      });
      store.garminFile(String(id), digest);
      return digest;
    }
    throw new Error(`Garmin activity ${id} ZIP did not contain a readable workout FIT, TCX or GPX.`);
  } finally { rmSync(tmp, {recursive:true,force:true}); }
}

export function garminPlan(store) {
  const counts = { missing:0, alreadyOnStrava:0, uploaded:0, staged:0, blocked:0 };
  const sample = [];
  for (const row of store.garminRows()) {
    if (row.file_status === 'uploaded' || row.state === 'uploaded') counts.uploaded++;
    else if (['uncertain','failed','processing'].includes(row.file_status) || row.state === 'failed') counts.blocked++;
    else if (row.state === 'skipped' || row.file_status === 'skipped' || duplicateFor(row,store)) counts.alreadyOnStrava++;
    else if (row.file_status === 'pending' || row.state === 'staged') counts.staged++;
    else {
      counts.missing++;
      if (sample.length < 8) sample.push(row);
    }
  }
  return {counts, sample};
}

export function printGarminPlan(store) {
  const {counts,sample} = garminPlan(store);
  console.log('\nGarmin → Strava migration preview:');
  console.log(`  Garmin activities indexed: ${store.countGarmin()}`);
  console.log(`  Missing from Strava (estimated): ${counts.missing}`);
  console.log(`  Likely already on Strava: ${counts.alreadyOnStrava}`);
  console.log(`  Downloaded / waiting to upload: ${counts.staged}`);
  console.log(`  Uploaded with this tool: ${counts.uploaded}`);
  console.log(`  Requiring attention: ${counts.blocked}`);
  for (const row of sample) {
    console.log(`    ${row.start_utc ? new Date(row.start_utc*1000).toISOString().slice(0,10) : 'unknown date'} | ${row.sport ?? 'unknown'} | ${row.name} (#${row.id})`);
  }
  if (counts.missing > sample.length) console.log(`    ... and ${counts.missing-sample.length} others`);
  if (store.getMeta('remote_synced_at')) console.log('  Matches are heuristic (UTC start time, distance and duration); review a small test batch.');
  else console.log('  WARNING: no complete Strava inventory yet. Missing counts may include existing activities.');
}

export async function stageGarmin(store, client, { max = 10, log = console.log } = {}) {
  if (!store.getMeta('remote_synced_at')) throw new Error('Complete a Strava activity inventory before downloading/uploading workouts.');
  let staged = 0, skipped = 0, failed = 0;
  for (const row of store.garminRows()) {
    if (staged >= max) break;
    if (['skipped','uploaded'].includes(row.state) || row.file_status === 'uploaded') continue;
    if (row.state === 'failed' || ['failed','uncertain','processing','skipped'].includes(row.file_status)) continue;
    if (row.file_digest && row.file_status === 'pending') {
      const stored = store.fileByDigest(row.file_digest);
      if (stored && existsSync(stored.path)) continue;
    }
    const already = duplicateFor(row, store);
    if (already) {
      store.garminState(row.id, 'skipped', { remoteId: already.id });
      skipped++;
      continue;
    }
    try {
      log(`  Downloading Garmin ${row.id} (${row.name})...`);
      const archive = await client.downloadActivity(row.id);
      await cacheGarminDownload(row.id, archive, store);
      staged++;
    } catch (err) {
      if (err.name === 'GarminPause') throw err;
      failed++;
      store.garminState(row.id,'failed',{error:err.message});
      log(`  Failed Garmin #${row.id}: ${err.message}`);
    }
  }
  reconcile(store,log);
  log(`Garmin download stage: ${staged} cached, ${skipped} known Strava matches skipped, ${failed} failed.`);
  return {staged,skipped,failed};
}

export async function runGarminMigration(store, garminClient, stravaClient, {max=10,log=console.log}={}) {
  // Upload each staged workout before downloading the next one. This checkpoints
  // actual Strava progress instead of collecting 1000 Garmin downloads first.
  let attemptedTotal = 0;
  while (attemptedTotal < max) {
    if (store.files(['pending','processing']).length) {
      const { attempted, blocked } = await migrate(store, stravaClient, { max:1, log });
      attemptedTotal += attempted;
      if (blocked) return;
      continue;
    }
    const { staged } = await stageGarmin(store, garminClient, { max:1, log });
    if (!staged) break;
  }
  log(`Migration run complete: ${attemptedTotal} upload attempts (limit ${max}).`);
}
