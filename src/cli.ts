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
import { HELP, parseFlags } from './cli/options.js';
import { printStatus } from './cli/status.js';


if (existsSync(resolve('.env'))) process.loadEnvFile(resolve('.env'));

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
