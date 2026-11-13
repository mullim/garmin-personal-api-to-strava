# Architecture and reliability notes

This is a **local-first, single-user CLI**. The objective is to migrate activity files safely
and audit existing Strava history without a hosted server, cloud database, or third-party credential vault.

## Source directories

| Directory | Responsibility |
|---|---|
| `src/cli.ts`, `src/cli/` | Command dispatch, argument validation, help, and text presentation |
| `src/domain/` | TypeScript contracts for API payloads, activities, database rows, duplicate findings |
| `src/integrations/garmin.ts` | Garmin Personal API auth, throttling, token caching, activity API |
| `src/integrations/strava.ts` | Strava OAuth, rate budget, activity inventory, upload/polling |
| `src/persistence/store.ts` | SQLite state; additive schema upgrades only |
| `src/migration/` | Discovery, reconciliation, file staging, safe resumable uploads |
| `src/audit/` | Read-only strict/sensitive duplicate matching and reports |
| `src/formats/` | Inspect original FIT/TCX/GPX and safely extract per-activity ZIP entries |

## Invariants

1. **Never assume an upload failed after a network timeout or 5xx.** An activity
   may already exist on Strava. Mark the file `uncertain`; require inspection before retry.
2. **Write migration progress after every meaningful step.** Discovery cursors
   and uploaded/processing states live in `~/.garmin-api-to-strava/migration.sqlite`.
3. **Do not mark a Strava inventory complete until the last page succeeds.**
   Incomplete page-by-page scans are resumed.
4. **Do not transform FIT files for migration.** The original file, when available,
   remains the authoritative workout payload.
5. **Audit is read-only.** Duplicate findings are heuristics for the athlete to
   review; even high-confidence findings never trigger deletion.
6. **Avoid fetching all detailed Strava activities by default.** Detailed requests
   are scoped to suspicious pairs and limited by the user's API allowance.

## Data security

- `.env` and OAuth tokens are never intended for Git. The local state directory
  is created with restricted permissions (0700), and token/data files use 0600.
- Reports can contain sensitive workout names, locations, and timestamps: keep
  them in the state directory and do not attach them to public issues.
- OAuth uses a random CSRF state and a localhost-only callback.
- Garmin ZIP decompression uses bounded, streamed extraction and rejects path traversal.
- To back up your state, stop the CLI before copying the SQLite database (including
  any associated WAL/shm files), or use SQLite's online backup functionality.

## Compatibility

The SQLite table names and columns from v0.3 are retained, and the new
`remote_activities` fields are created additively. There is no destructive
migration or automatic state reset.

Build output is emitted to `dist/` and not tracked. The legacy
`node src/cli.mjs` path is a thin shim; use `npm ci` and `npm run build`
on a fresh checkout before invoking it.

## Extending safely

New providers should expose a small typed client interface and keep retry/idempotency
semantics in the workflow layer rather than mixing them into HTTP response parsing.
Use mocked provider responses in unit tests; **never commit real athlete files,
API keys, tokens, routes, or Strava account exports**.
