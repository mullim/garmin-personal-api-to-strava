import { RateLimitPause } from './strava.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function isLikelyDuplicate(local, remote) {
  if (local.start_utc == null || remote.start_utc == null) return false;
  if (Math.abs(local.start_utc - remote.start_utc) > 3) return false;
  if (local.distance_m != null && remote.distance_m != null && local.distance_m > 0 && remote.distance_m > 0) {
    if (Math.abs(local.distance_m - remote.distance_m) > Math.max(100, Math.max(local.distance_m, remote.distance_m) * 0.05)) return false;
  }
  if (local.duration_seconds != null && remote.duration_seconds != null && local.duration_seconds > 0 && remote.duration_seconds > 0) {
    if (Math.abs(local.duration_seconds - remote.duration_seconds) > Math.max(180, Math.max(local.duration_seconds,remote.duration_seconds) * 0.15)) return false;
  }
  return true;
}

export function duplicateFor(file, store) {
  return store.remoteNear(file.start_utc).find(a => isLikelyDuplicate(file, a));
}

export async function syncRemote(store, client, log = console.log, force = false) {
  const completed = store.getMeta('remote_synced_at');
  if (!force && completed && Date.now() - Date.parse(completed) < 10 * 60 * 1000) {
    log(`Using recent Strava inventory (${store.countRemote()} activities, ${completed}).`);
    return;
  }
  let page = Number(store.getMeta('remote_sync_next_page') ?? 1);
  if (force || !page || page === 1) {
    store.clearRemote();
    store.setMeta('remote_synced_at', '');
    page = 1;
  }
  log(`Syncing existing Strava activities, starting at page ${page} ...`);
  for (; page < 10000; page++) {
    // Set the resume cursor BEFORE requesting the page. If it fails, retry this page.
    store.setMeta('remote_sync_next_page', page);
    const batch = await client.activities(page);
    if (!Array.isArray(batch)) throw new Error('Unexpected Strava activity-list response');
    for (const activity of batch) store.upsertRemote(activity);
    if (batch.length < 100) {
      store.setMeta('remote_sync_next_page', 1);
      store.setMeta('remote_synced_at', new Date().toISOString());
      log(`Strava inventory complete: ${store.countRemote()} activities.`);
      return;
    }
    if (page % 10 === 0) log(`  Indexed ${store.countRemote()} Strava activities...`);
  }
  throw new Error('Reached a safety limit of 1,000,000 Strava activities.');
}

export function reconcile(store, log = console.log) {
  let skipped = 0;
  for (const file of store.files(['pending','failed','uncertain'])) {
    const match = duplicateFor(file, store);
    if (match) {
      store.updateFile(file.digest, 'skipped', { remoteActivityId: match.id, error: 'Already on Strava (matched start, duration/distance where available)' });
      skipped++;
    }
  }
  if (skipped) log(`Matched and skipped ${skipped} activities already on Strava.`);
  return skipped;
}

function stravaId(upload) {
  return upload.id_str ?? (upload.id == null ? null : String(upload.id));
}
function createdActivityId(upload) {
  return upload.activity_id_str ?? (upload.activity_id == null ? null : String(upload.activity_id));
}

export async function pollUpload(file, store, client, log = console.log) {
  if (!file.upload_id) {
    store.updateFile(file.digest, 'uncertain', { error:'Missing upload ID; confirm on Strava before retrying.' });
    return false;
  }
  for (let tries = 0; tries < 5; tries++) {
    await sleep(tries === 0 ? 2500 : 3000 * (tries+1));
    const upload = await client.uploadStatus(file.upload_id);
    const activityId = createdActivityId(upload);
    if (activityId) {
      store.updateFile(file.digest, 'uploaded', { remoteActivityId: activityId });
      log(`  Uploaded -> https://www.strava.com/activities/${activityId}`);
      return true;
    }
    if (upload.error || /error processing|deleted/i.test(upload.status ?? '')) {
      const err = String(upload.error ?? upload.status);
      const matched = err.match(/duplicate of activity (\d+)/i);
      store.updateFile(file.digest, matched ? 'skipped' : 'failed', {
        remoteActivityId: matched?.[1], error:err
      });
      log(`  ${matched ? 'Duplicate' : 'Rejected'}: ${err}`);
      return true;
    }
  }
  log('  Still processing. Saved upload ID; run resume later.');
  return false;
}

export async function migrate(store, client, { max = 25, log = console.log } = {}) {
  if (!store.getMeta('remote_synced_at')) throw new Error('Strava inventory has not finished syncing; do not upload until sync completes.');
  // Always resolve submitted uploads before submitting new ones.
  for (const processing of store.files(['processing'])) {
    log(`Checking previously submitted: ${processing.original_path}`);
    if (!await pollUpload(processing, store, client, log)) return {attempted:0,blocked:true};
  }
  let attempted = 0;
  for (const file of store.files(['pending'])) {
    const dupe = duplicateFor(file, store);
    if (dupe) {
      store.updateFile(file.digest, 'skipped', { remoteActivityId:dupe.id, error:'Already present on Strava' });
      continue;
    }
    if (attempted >= max) break;
    attempted++;
    log(`[${attempted}/${max}] Uploading ${file.original_path}`);
    let upload;
    try { upload = await client.upload(file); }
    catch(err) {
      if (err instanceof RateLimitPause) throw err;
      // Request may have reached Strava despite 5xx/network failure. Mark it
      // uncertain, and never automatically retry it.
      const uncertain = !err.status || err.status >= 500;
      store.updateFile(file.digest, uncertain ? 'uncertain' : 'failed', { error:err.message });
      log(`  ${uncertain ? 'Uncertain outcome' : 'Rejected'}: ${err.message}`);
      if (uncertain) throw new Error('Upload outcome uncertain. Run sync, inspect Strava, then use --retry-uncertain only after confirming it is missing.');
      continue;
    }
    const uploadId = stravaId(upload);
    if (!uploadId) {
      store.updateFile(file.digest, 'uncertain', { error:'Strava accepted upload but did not return an upload ID' });
      throw new Error('Missing upload ID; please check Strava before retrying.');
    }
    store.updateFile(file.digest, 'processing', { uploadId });
    if (!await pollUpload({ ...file, upload_id:uploadId }, store, client, log)) return {attempted,blocked:true};
  }
  if (attempted) log(`Finished this batch (${attempted} upload attempts).`);
  return {attempted, blocked:false};
}
