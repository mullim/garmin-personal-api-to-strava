#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store, getHome } from './persistence/store.js';
import { GarminClient, GarminPause } from './integrations/garmin.js';
import { authorize, hasToken, StravaClient, RateLimitPause } from './integrations/strava.js';
import { syncRemote, reconcile } from './migration/migrate.js';
import { discoverGarmin, printGarminPlan, runGarminMigration } from './migration/garmin-import.js';
import { findDuplicatePairs, enrichCandidateDetails, printDuplicatePairs, saveDuplicateReport } from './audit/duplicates.js';
import { findSensitivePairs } from './audit/duplicates-sensitive.js';

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
  duplicates                   Audit all Strava workouts for overlapping duplicates
  duplicates --deep            Also fetch detailed metadata for candidates
  duplicates --sensitive       Report more possible duplicates for manual review
  status                       Show migration status and attention items

Options:
  --yes                        Explicitly enable uploads (otherwise none)
  --max N                      Maximum new Strava uploads in this run (default 10)
  --refresh-garmin             Start Garmin enumeration from offset 0 again
  --refresh-strava             Rebuild your Strava inventory
  --retry-failed               With resume --yes, reattempt rejected Garmin downloads or Strava files
  --retry-uncertain            With resume --yes --refresh-strava ONLY, after
                               manually checking missing entries on Strava
  --deep                       For duplicates, fetch details of likely matches
  --sensitive                  Broader read-only candidate detection; may include false positives
  --max-details N              Limit extra Strava detail requests (default 30)
  --min-confidence LEVEL       high, medium or review (default review)
  --out PATH                   Duplicate report base path (writes .csv and .json)

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
    } else if (['--max-details','--min-confidence','--out'].includes(args[i])) {
      const flag=args[i];
      const value=args[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`);
      if (flag === '--max-details') {
        values.maxDetails = Number(value);
        if (!Number.isSafeInteger(values.maxDetails) || values.maxDetails < 0 || values.maxDetails > 500)
          throw new Error('--max-details must be between 0 and 500');
      } else if (flag === '--min-confidence') {
        if (!['high','medium','review'].includes(value)) throw new Error('--min-confidence must be high, medium or review');
        values.minConfidence=value;
      } else values.out=value;
    } else if (['--yes','--deep','--sensitive','--refresh-garmin','--refresh-strava','--retry-failed','--retry-uncertain'].includes(args[i])) {
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
    } else if (cmd === 'duplicates') {
      if (flags.has('--yes') || flags.has('--retry-failed') || flags.has('--retry-uncertain') ||
          flags.has('--refresh-garmin') || values.max !== undefined) {
        throw new Error('duplicates is read-only and does not accept migration upload flags');
      }
      if (!hasToken(store.home)) throw new Error('Authorize Strava first with: node src/cli.mjs auth');
      const strava=new StravaClient(store.home);
      await syncRemote(store,strava,console.log,flags.has('--refresh-strava'));
      const detect=flags.has('--sensitive') ? findSensitivePairs : findDuplicatePairs;
      let pairs=detect(store.remoteAll());
      if (flags.has('--deep') && pairs.length) {
        await enrichCandidateDetails(store,strava,pairs,{max:values.maxDetails ?? 30});
        pairs=detect(store.remoteAll());
      }
      const severity={high:0,medium:1,review:2};
      pairs=pairs.filter(p=>severity[p.confidence]<=severity[values.minConfidence ?? 'review']);
      printDuplicatePairs(pairs,{totalActivities:store.countRemote()});
      saveDuplicateReport(store,pairs,{out:values.out ? resolve(values.out) : null});
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
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof GarminPause || err instanceof RateLimitPause)
    console.error('Migration state is saved. Run resume when the relevant rate-limit window has reset.');
  process.exitCode = 1;
});
