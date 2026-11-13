/**
 * Human-readable migration status. This layer never changes persisted state.
 */
import type { Store } from '../persistence/store.js';

export function printStatus(store: Store) {
  console.log(`\nLocal migration state: ${store.home}`);
  console.log(`Garmin activities indexed: ${store.countGarmin()}`);
  console.log(`Last complete Garmin discovery: ${store.getMeta('garmin_discovered_at') || 'not completed'}`);
  console.log(`Strava activities indexed: ${store.countRemote()}`);
  console.log(`Last complete Strava inventory: ${store.getMeta('remote_synced_at') || 'not completed'}`);
  const rows = store.counts();
  console.log(`Activity files cached: ${rows.reduce((a,row)=>a+row.count,0)}`);
  for (const row of rows) console.log(`  ${row.status.padEnd(12)} ${row.count}`);
  const failedGarmin = store.garminRows().filter(x => x.state === 'failed');
  const failedUpload = store.files(['uncertain','failed']);
  if (failedGarmin.length || failedUpload.length) {
    console.log('\nAttention needed:');
    for (const row of failedGarmin.slice(0,10)) console.log(`  Garmin #${row.id}: ${row.error}`);
    for (const row of failedUpload.slice(0,10)) console.log(`  Strava ${row.status}: ${row.original_path}: ${row.error}`);
  }
  console.log('');
}

