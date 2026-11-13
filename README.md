# Garmin Personal API → Strava CLI

Transfer **historical Garmin Connect activities directly using Garmin's official new Personal API**, without a Garmin account export or password scraping. Garmin activities are enumerated from its API and original FIT files are downloaded per activity, then sent to Strava using its official upload endpoint.

## Audit duplicate Strava workouts (Apple Watch + Garmin)

After importing workouts from Apple Watch via HealthFit and Garmin via this CLI, you may have overlapping recordings of the same session. The read-only duplicate audit scans **all Strava activities**, not just workouts imported by the CLI.

```bash
# Refresh the whole Strava inventory and flag overlapping sessions
node src/cli.mjs duplicates --refresh-strava

# Optional deeper check: fetch detailed device information and route polylines
# only for suspicious pairs (up to 30 extra activity requests by default).
node src/cli.mjs duplicates --deep

# Raise the detailed-fetch cap within your Strava API read limits
node src/cli.mjs duplicates --deep --max-details 100

# Show high-confidence matches only; write reports to custom location
node src/cli.mjs duplicates --min-confidence high --out ./strava-review
```

The audit produces CSV and JSON under `~/.garmin-api-to-strava/reports/` by default. The CSV contains clickable links to both activities plus distance, duration, start-time difference, percentage of overlapping elapsed time, potential device names, and a confidence label (`high`, `medium`, `review`).

**How matching works:** two sessions on the same day are NOT enough. The tool looks for meaningful UTC elapsed-time overlap and compatible sports (e.g. Run/TrailRun or WeightTraining/Workout). Distances and durations can differ between watches. For flagged pairs, optional `--deep` fetches route/device metadata and evaluates mapped route proximity when available. Two separate morning/evening strength sessions are not flagged. GPS is not required for strength-session matching.

**Safety:** This command never modifies or deletes anything on Strava. Matches are heuristic, not proof of duplication; review each pair before deleting either activity manually. Strava API rate limits apply to the initial activity inventory and optional detailed reads; completed page-by-page inventory sync can resume after throttling. The audit uses the last cached inventory if a complete sync was performed within 10 minutes; force `--refresh-strava` when you know newer Apple Watch activities have arrived.


**Status:** Tested against mocked Garmin and Strava API responses, **not yet against your live Garmin/Strava accounts**. Test with three activities first. This is a personal, local-only tool; Garmin's Personal API is not for commercial multi-user services.

## Requirements

- macOS (or Linux) with Node.js 22.13+ (Node 24 recommended) and `unzip` installed. No `npm install` needed.
- Your **Garmin Connect Personal API key**, generated in Garmin Connect web.
- A Strava API application and Client ID / Client Secret. Strava currently requires a subscription to create an API app.

## 1. Get your Garmin Personal API key

1. Open [Garmin Connect](https://connect.garmin.com/modern/) in a desktop browser and sign in.
2. Go to **Profile & Account → Settings → Personal API Key → Create Key**.
3. Accept terms, choose an expiration period, create and copy the API key (Garmin only displays it once).
4. **Never paste the key into this chat or commit it to Git.** Garmin uses the key to exchange for a 24-hour JWT access token.

[Official Garmin guide](https://support.garmin.com/en-US/?faq=HfTwLfw1Gn2A7WS1GdAMH8)

## 2. Set up Strava

1. Create an application at [Strava API Settings](https://www.strava.com/settings/api).
2. Set **Authorization Callback Domain** to `localhost`.
3. Copy your Client ID and Client Secret.
4. In the project directory:

```bash
cp .env.example .env
```

Edit `.env`:

```dotenv
GARMIN_PERSONAL_API_KEY=your_garmin_personal_api_key
STRAVA_CLIENT_ID=your_strava_client_id
STRAVA_CLIENT_SECRET=your_strava_client_secret
```

For extra privacy, you can store the Garmin key in a file with `chmod 600` and set `GARMIN_PERSONAL_API_KEY_FILE=/path/to/key` instead.

## 3. Verify both connections

```bash
node src/cli.mjs garmin-test   # Genuine Garmin Personal API request
node src/cli.mjs auth          # Opens Strava OAuth in your browser
```

Garmin doesn't require a browser OAuth flow: its **self-generated key** is exchanged at `POST /personalapitoken-service/personal-api/personal-api-key/token` with the header `Authorization: ApiKey <key>`. The bearer JWT is cached securely and renewed automatically when needed.

Strava OAuth requests `activity:read_all` (for private activity duplicate checks) and `activity:write` (to upload). OAuth returns to localhost:37541, and your credentials remain on your Mac.

## 4. Preview everything without transferring

```bash
node src/cli.mjs import
```

This **lists your complete Garmin history via `GET /activitylist-service/activities/search/activities?start=&limit=`**, saves activity summaries to SQLite, and fetches your existing Strava inventory to identify likely duplicates. It shows counts and sample workouts. It **does not download FIT files or upload anything** unless `--yes` is present.

To force a fresh Garmin enumeration or Strava inventory:

```bash
node src/cli.mjs import --refresh-garmin --refresh-strava
```

Garmin's activity listings are paginated with an offset of 20 per request. Interrupted discovery resumes where it stopped. Once discovery completes, it is cached until you request `--refresh-garmin`.

## 5. Transfer a few workouts, then resume

**Privacy first:** Set your Strava default activity visibility to **Only You** before importing if you want these historical activities private. Strava's upload endpoint does not accept a reliable per-upload private flag.

```bash
# Download the original activity ZIPs from the Garmin Personal API,
# extract FIT workouts locally, and upload at most THREE to Strava.
node src/cli.mjs import --yes --max 3

# Review those activities in Strava, then continue in small batches
node src/cli.mjs resume --yes --max 10

# Inspect progress and errors
node src/cli.mjs status
```

The download endpoint used is `GET /download-service/files/activity/{activityId}`. The downloaded ZIP's original workout FIT file is cached locally and uploaded without conversion. A single Garmin activity is never uploaded multiple times just because its ZIP contains FIT plus alternative TCX/GPX representations. If a download is ambiguous, the tool refuses to import it.

An activity already present in Strava is identified conservatively by matching start time (±3 seconds), distance and duration when available. The check is heuristic. The tool also supplies a deterministic external ID to Strava; Strava might still reject duplicates.

## Resumption and error handling

Data is stored in `~/.garmin-api-to-strava/` by default:

```text
migration.sqlite     # Garmin IDs, activity summaries, Strava inventory, upload statuses
activities/          # Original workout FIT/TCX/GPX bytes from Garmin's per-activity API ZIPs
garmin-token.json     # Garmin JWT; cached with 0600 permissions
 token.json           # Strava OAuth tokens; cached with 0600 permissions
```

No Garmin account export ZIP is required or used. The app never needs your Garmin password. Uploads require explicit `--yes` and save state before polling, so if your connection drops, `resume` checks prior upload IDs rather than blindly duplicating activities.

If an upload request ends in a network error, its outcome is considered **uncertain**. The CLI **will not automatically retry it**, since Strava might have accepted the workout. After checking Strava yourself:

```bash
node src/cli.mjs sync --refresh-strava
node src/cli.mjs resume --yes --retry-failed --max 10
# For truly uncertain requests ONLY, after checking the workout isn't in Strava:
node src/cli.mjs resume --yes --refresh-strava --retry-uncertain --max 10
```

Garmin-download failures are recorded and not retried automatically (to avoid hammering potentially unsupported activities). Use `resume --yes --retry-failed` after investigating the cause; this explicitly resets failed Garmin downloads as well as rejected Strava file uploads. You can inspect failures with `status`.

**Garmin HTTP 429:** The app saves the `Retry-After` reset time if Garmin sends one. Otherwise it saves a conservative local cooldown (starting at 30 minutes, escalating after consecutive 429s). This **is not an official Garmin reset time**. During the cooldown, subsequent runs refuse to issue new Garmin requests. Garmin calls are spaced by at least 2 seconds by default (configurable with `GARMIN_MIN_INTERVAL_MS=3000` in `.env` if needed). After the printed cooldown time, run:

```bash
node src/cli.mjs status
node src/cli.mjs resume --yes --max 100
```

The importer now **uploads staged workouts one by one** before downloading the next, so Garmin throttling cannot prevent previously staged activity files from being transferred. Strava request budget headers are honored and uploading stops when its budget is low. No undocumented Garmin quota or reset period is assumed.

## Limitations

- Original FIT data can include heart rate, power, cadence and GPS but Strava only preserves fields it supports. This is **workout migration**, not wellness data such as sleep/steps.
- Files are downloaded locally **on demand**, only for missing workouts being staged; the dry-run queries summaries only.
- The tool uses Garmin's **Personal API**, intended for your own account rather than a hosted multi-user product.
- The first attempt with a real Garmin Personal API key may reveal account-specific response details, so validate on a small batch before importing your entire history.
- If you switch Garmin or Strava accounts, use a different `G2S_HOME`. Do not re-use the database across athletes.
- Some Garmin activities might not have a downloadable file or the activity may have a format Strava doesn't support; those are reported as failures rather than silently skipped.

## Tests

```bash
npm test
node src/cli.mjs help
```

No network or secrets are used by automated tests. They exercise Garmin JWT authentication, pagination and resumability, per-activity FIT extraction, duplicate detection, and Strava upload safety.

## Official references

- [Garmin Personal API FAQ and token exchange](https://developer.garmin.com/gc-developer-program/personal/personal-faq)
- [Garmin Personal API Swagger endpoints](https://developer.garmin.com/gc-developer-program/personal/swagger-docs/)
- [Garmin official reference client](https://github.com/garmin/connect-personal-api-python)
- [Strava upload API](https://developers.strava.com/docs/uploads/)
- [Strava authentication](https://developers.strava.com/docs/authentication/)
- [Strava rate limits](https://developers.strava.com/docs/rate-limits/)
