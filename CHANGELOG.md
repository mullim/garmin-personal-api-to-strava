# Changelog

## 0.4.0-beta.1 — TypeScript refactor

- Reorganized the JavaScript implementation into strict-checked TypeScript modules
  (CLI, domain types, integrations, persistence, migration, audit, file formats).
- Added typed contracts for persisted activity rows, provider responses, migration
  files, and duplicate candidate reports.
- Added a cross-platform ZIP reader based on `yauzl` with entry and decompression limits.
- Added per-request Strava HTTP timeouts and preserved uncertain-upload handling.
- Added CI build/typecheck/test workflow and committed npm dependency lockfile.
- Preserved the existing SQLite state directory and all CLI commands, plus a
  backwards-compatible `src/cli.mjs` entrypoint after compilation.
- Added tests for legacy SQLite schema upgrades and ZIP entry safety.

**Setup change:** dependencies must now be installed and TypeScript compiled:
`npm ci && npm run build`. Existing credentials and migration state should remain
in their original location.
