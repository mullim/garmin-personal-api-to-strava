/**
 * CLI option parsing is deliberately independent of network, SQLite, and
 * provider credentials. This also allows future interfaces to reuse workflows.
 */
export const HELP = `Garmin Personal API -> Strava (local CLI, no exports or scraping)

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

export function parseFlags(args: string[]) {
  const flags = new Set();
  const values: {max?: number;maxDetails?: number;minConfidence?: 'high'|'medium'|'review';out?:string} = {};
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
        values.minConfidence=value as 'high'|'medium'|'review';
      } else values.out=value;
    } else if (['--yes','--deep','--sensitive','--refresh-garmin','--refresh-strava','--retry-failed','--retry-uncertain'].includes(args[i])) {
      flags.add(args[i]);
    } else throw new Error(`Unknown option: ${args[i]}`);
  }
  return {flags,values};
}

