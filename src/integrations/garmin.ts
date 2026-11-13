import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Official Garmin Connect Personal API: https://developer.garmin.com/gc-developer-program/personal/swagger-docs/
import type { GarminActivity } from '../domain/types.js';

const DEFAULT_BASE = 'https://personal.connectapi.garmin.com';
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
const MAX_DOWNLOAD = 64 * 1024 * 1024;

export class GarminPause extends Error {
  readonly retryAt: number | null;
  constructor(message: string, retryAt: number | null = null) {
    super(message);
    this.name = 'GarminPause';
    this.retryAt = retryAt;
  }
}

// Garmin does not publish a fixed Personal API quota or reset window.
// Only Retry-After is authoritative; otherwise this is a conservative local cooldown.
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export function retryAfterMs(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const raw = header.trim();
  if (/^\d+$/.test(raw)) return Math.max(0, Number(raw) * 1000);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed - now) : null;
}

export function garminApiKey() {
  const fromEnv = process.env.GARMIN_PERSONAL_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const path = process.env.GARMIN_PERSONAL_API_KEY_FILE;
  if (path) {
    const fromFile = readFileSync(path, 'utf8').trim();
    if (fromFile) return fromFile;
  }
  throw new Error('Set GARMIN_PERSONAL_API_KEY in .env (create your key in Garmin Connect > Settings > Personal API Key).');
}

export function jwtExpiresAt(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    if (!Number.isFinite(Number(payload.exp))) throw new Error('missing exp');
    return Number(payload.exp);
  } catch { throw new Error('Garmin token response was not a JWT with an exp claim.'); }
}

export function normalizeGarminActivity(raw: Record<string, any>): GarminActivity {
  const id = String(raw?.activityId ?? raw?.id ?? '');
  if (!/^\d+$/.test(id) || Number(id) <= 0) throw new Error('Garmin returned an activity without a valid positive numeric activityId');
  const date = raw.startTimeGMT ?? raw.startTimeUTC ?? raw.startTimeUtc ?? null;
  let startUtc: number | null = null;
  if (typeof date === 'number') startUtc = Math.floor(date > 1e12 ? date / 1000 : date);
  else if (typeof date === 'string') {
    const iso = date.trim().replace(' ', 'T');
    const parsed = Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`);
    if (Number.isFinite(parsed)) startUtc = Math.floor(parsed / 1000);
  }
  const numOrNull = value => value != null && Number.isFinite(Number(value)) ? Number(value) : null;
  return {
    id,
    name: String(raw.activityName ?? raw.name ?? `Garmin ${id}`).slice(0, 200),
    startUtc,
    durationSeconds: numOrNull(raw.duration ?? raw.elapsedDuration),
    distanceM: numOrNull(raw.distance),
    sport: raw.activityType?.typeKey ?? raw.activityType?.parentTypeId ?? raw.activityType ?? null,
  };
}

export class GarminClient {
  readonly home: string;
  private readonly fetchFn: typeof fetch;
  private readonly base: string;
  private readonly minIntervalMs: number;
  private nextRequest: number;
  private readonly tokenPath: string;
  private readonly cooldownPath: string;
  constructor(home, fetchFn = fetch, { baseUrl = process.env.GARMIN_PERSONAL_API_BASE_URL || DEFAULT_BASE, minIntervalMs = Number(process.env.GARMIN_MIN_INTERVAL_MS ?? 2000) } = {}) {
    this.home = home;
    this.fetchFn = fetchFn;
    this.base = baseUrl.replace(/\/$/, '');
    if (!Number.isSafeInteger(minIntervalMs) || minIntervalMs < 0) throw new Error('GARMIN_MIN_INTERVAL_MS must be a nonnegative integer.');
    this.minIntervalMs = minIntervalMs;
    this.nextRequest = 0;
    this.tokenPath = join(home, 'garmin-token.json');
    this.cooldownPath = join(home, 'garmin-cooldown.json');
  }

  readCooldown() {
    try { return JSON.parse(readFileSync(this.cooldownPath, 'utf8')); }
    catch { return null; }
  }

  ensureCooldownExpired() {
    const until = this.readCooldown()?.until;
    if (Number.isFinite(until) && until > Date.now()) {
      throw new GarminPause(`Garmin cooldown active until ${new Date(until).toLocaleString()}. Resume after that time.`, until);
    }
  }

  onRateLimit(response) {
    const now = Date.now();
    const prior = this.readCooldown();
    const strikes = prior?.lastAt && now - prior.lastAt < DAY ? Math.min(6, (prior.strikes || 0) + 1) : 1;
    const requestedMs = retryAfterMs(response.headers.get('retry-after'), now);
    const delay = requestedMs ?? Math.min(30 * MINUTE * 2 ** (strikes - 1), 6 * 60 * MINUTE);
    const until = now + delay;
    writeFileSync(this.cooldownPath, JSON.stringify({ until, strikes, lastAt: now }), { mode: 0o600 });
    chmodSync(this.cooldownPath, 0o600);
    const source = requestedMs != null ? 'Garmin Retry-After header' : 'conservative fallback (Garmin reset time is not published)';
    throw new GarminPause(`Garmin returned HTTP 429. Cooldown until ${new Date(until).toLocaleString()} (${source}).`, until);
  }

  async throttle() {
    this.ensureCooldownExpired();
    const delay = this.nextRequest - Date.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    this.ensureCooldownExpired();
    this.nextRequest = Date.now() + this.minIntervalMs;
  }

  async accessToken(force = false) {
    const key = garminApiKey();
    const fingerprint = createHash('sha256').update(`${this.base}\0${key}`).digest('hex');
    if (!force && existsSync(this.tokenPath)) {
      try {
        const cached = JSON.parse(readFileSync(this.tokenPath, 'utf8'));
        if (cached.fingerprint === fingerprint && cached.expires_at > Date.now()/1000 + 3600) return cached.access_token;
      } catch { /* Request a fresh token if cache is malformed. */ }
    }
    await this.throttle();
    const response = await this.fetchFn(`${this.base}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { Authorization: `ApiKey ${key}`, Accept: '*/*' },
      signal: AbortSignal.timeout(30000),
    });
    if (response.status === 429) this.onRateLimit(response);
    if (!response.ok) throw new Error(`Garmin token API returned HTTP ${response.status}. Check your API key and expiration.`);
    // Garmin's official token endpoint returns a raw JWT string, not a JSON object.
    const token = (await response.text()).trim();
    const expiresAt = jwtExpiresAt(token);
    if (expiresAt < Date.now()/1000 + 60) throw new Error('Garmin returned an expired or nearly expired token.');
    writeFileSync(this.tokenPath, JSON.stringify({ fingerprint, access_token: token, expires_at: expiresAt }), {mode:0o600});
    chmodSync(this.tokenPath, 0o600);
    return token;
  }

  async get(path, { accept = 'application/json', binary = false } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(attempt > 0);
      await this.throttle();
      const response = await this.fetchFn(`${this.base}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: accept },
        signal: AbortSignal.timeout(30000),
      });
      if (response.status === 401 && attempt === 0) continue;
      if (response.status === 429) this.onRateLimit(response);
      if (!response.ok) throw new Error(`Garmin Personal API GET ${path.split('?')[0]} returned HTTP ${response.status}.`);
      if (binary) {
        const statedSize = Number(response.headers.get('content-length') ?? 0);
        if (statedSize > MAX_DOWNLOAD) throw new Error('Garmin activity ZIP exceeds 64 MiB safety limit.');
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > MAX_DOWNLOAD) throw new Error('Garmin activity ZIP exceeds 64 MiB safety limit.');
        if (bytes.subarray(0,4).toString('hex') !== '504b0304') throw new Error('Garmin did not return an activity ZIP archive.');
        return bytes;
      }
      return response.json();
    }
    throw new Error('Garmin authentication failed after renewing the bearer token.');
  }

  async testConnection() { return this.get('/userprofile-service/userprofile/settings'); }
  async activities(start = 0, limit = 20): Promise<GarminActivity[]> {
    const result = await this.get(`/activitylist-service/activities/search/activities?start=${start}&limit=${limit}`);
    const rows = Array.isArray(result) ? result : result?.activities;
    if (!Array.isArray(rows)) throw new Error('Unexpected Garmin activity-list response shape; please report the non-secret response structure.');
    return rows.map(normalizeGarminActivity);
  }
  downloadActivity(id) {
    if (!/^\d+$/.test(String(id)) || BigInt(id) <= 0n) throw new Error('Invalid Garmin activity ID');
    return this.get(`/download-service/files/activity/${id}`, {
      binary: true, accept: 'application/zip, application/x-zip-compressed, application/octet-stream',
    });
  }
}
