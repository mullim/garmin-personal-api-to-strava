#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store, getHome } from './store.mjs';
import { GarminClient, GarminPause } from './garmin.mjs';
import { authorize, hasToken, StravaClient, RateLimitPause } from './strava.mjs';
import { syncRemote, reconcile } from './migrate.mjs';
import { discoverGarmin, printGarminPlan, runGarminMigration } from './garmin-import.mjs';

if (existsSync(resolve('.env'))) process.loadEnvFile(resolve('.env'));

const HELP = `Garmin Personal API -> Strava (local CLI, no exports or scraping)

Usage: node src/cli.mjs <command> [options]

  garmin-test                  Verify your official Garmin Personal API key
  auth                         Authorize Strava via browser (OAuth)
  discover                     Read all Garmin activity summaries; index locally
  import                       Discover Garmin, compare with Strava (DRY RUN)
  import --yes --max 3          Download original FITs from Garmin API and upload 3
  resume --yes --max 10         Continue any interrupted migration
  sync --refresh-strava        Reindex Strava for duplicate detection
  status                       Show migration status and attention items

Options:
  --yes                        Explicitly enable uploads (otherwise none)
  --max N                      Maximum new Strava uploads in this run (default 10)
  --refresh-garmin             Start Garmin enumeration from offset 0 again
  --refresh-strava             Rebuild your Strava inventory
  --retry-failed               With resume --yes, reattempt rejected Garmin downloads or Strava files
  --retry-uncertain            With resume --yes --refresh-strava ONLY, after
                               manually checking missing entries on Strava

Setup: copy .env.example to .env, add GARMIN_PERSONAL_API_KEY and Strava API
credentials, then run 'garmin-test', 'auth', and 'import'.

Privacy: Strava uses your account's default visibility for uploads. Set it to
'Only You' in Strava BEFORE importing if you want workouts private.
`;

function parseFlags(args) {
  const flags = new Set();
  const values = {};
  for (let i=0; i<args.length; i++) {
    if (args[i] === '--max') {
      values.max = Number(args[++i]);
      if (!Number.isSafeInteger(values.max) || values.max < 1 || values.max > 1000)
        throw new Error('--max must be an integer between 1 and 1000');
    } else if (['--yes','--refresh-garmin','--refresh-strava','--retry-failed','--retry-uncertain'].includes(args[i])) {
      flags.add(args[i]);
    } else throw new Error(`Unknown option: ${args[i]}`);
  }
  return {flags,values};
}

function printStatus(store) {
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

async function main() {
  const [cmd,...args] = process.argv.slice(2);
  if (!cmd || ['help','--help','-h'].includes(cmd)) { console.log(HELP); return; }
  const {flags,values} = parseFlags(args);
  const store = new Store(getHome());
  try {
    const garmin = new GarminClient(store.home);
    if (cmd === 'garmin-test') {
      await garmin.testConnection();
      console.log('Garmin Personal API authentication succeeded.');
    } else if (cmd === 'auth') {
      await authorize(store.home);
      console.log('Strava authorized. Next: node src/cli.mjs import');
    } else if (cmd === 'discover') {
      await discoverGarmin(store,garmin,console.log,flags.has('--refresh-garmin'));
      printStatus(store);
    } else if (cmd === 'sync') {
      if (!hasToken(store.home)) throw new Error('Authorize Strava first with: node src/cli.mjs auth');
      await syncRemote(store,new StravaClient(store.home),console.log,flags.has('--refresh-strava'));
      reconcile(store);
      printStatus(store);
    } else if (cmd === 'import' || cmd === 'resume') {
      if (!hasToken(store.home)) throw new Error('Authorize Strava first with: node src/cli.mjs auth');
      if (cmd === 'resume' && !flags.has('--yes')) throw new Error('Resume requires --yes. To preview safely, run import.');
      if (flags.has('--retry-uncertain') && !flags.has('--refresh-strava')) throw new Error('--retry-uncertain requires --refresh-strava and a manual Strava check.');
      if ((flags.has('--retry-failed') || flags.has('--retry-uncertain')) && cmd !== 'resume') throw new Error('Retry flags work only with resume --yes.');
      await discoverGarmin(store,garmin,console.log,flags.has('--refresh-garmin'));
      const strava = new StravaClient(store.home);
      await syncRemote(store,strava,console.log,flags.has('--refresh-strava'));
      reconcile(store);
      printGarminPlan(store);
      if (flags.has('--yes')) {
        if (flags.has('--retry-failed') || flags.has('--retry-uncertain')) {
          store.resetFailed(flags.has('--retry-uncertain'));
          if (flags.has('--retry-failed')) store.resetGarminFailed();
          reconcile(store);
        }
        await runGarminMigration(store,garmin,strava,{max:values.max ?? 10});
        printStatus(store);
      } else console.log('\nDRY RUN: no Garmin activity files downloaded and nothing uploaded. To migrate: node src/cli.mjs import --yes --max 3');
    } else if (cmd === 'status') {
      printStatus(store);
      if (store.countGarmin()) printGarminPlan(store);
    } else throw new Error(`Unknown command '${cmd}'.\n\n${HELP}`);
  } finally { store.close(); }
}

main().catch(err => {
  console.error(`\nError: ${err.message}`);
  if (err instanceof GarminPause || err instanceof RateLimitPause)
    console.error('Migration state is saved. Run resume when the relevant rate-limit window has reset.');
  process.exitCode = 1;
});
