# Contributing

Thanks for helping improve a privacy-first migration tool.

## Local setup

- Node.js 22.13+ (CI tests Node.js 22 and 24).
- Run `npm ci` and `npm test`.
- `npm run typecheck` must pass with `strict` and `noImplicitAny` enabled.
- Run `npm run dev -- help` while iterating on commands.
- Tests should use synthetic FIT/ZIP fixtures and mocked Garmin/Strava HTTP responses.

## Pull requests

1. Keep changes scoped and write tests for new parser, rate-limit, state, or duplicate logic.
2. Avoid breaking `~/.garmin-api-to-strava/migration.sqlite` compatibility.
3. Explain how data loss, duplicate uploads, and rate-limit exhaustion are prevented.
4. Never include live athlete data, GPS tracks, tokens, cookies, or API keys.
5. For new integration proposals, document the provider's auth, quota, and API terms.

Report suspected security issues privately to the repository maintainer through
GitHub's private vulnerability reporting channel if enabled.
