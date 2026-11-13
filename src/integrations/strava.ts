import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import type { StravaActivitySummary, StravaActivityDetail, StravaUploadResponse } from '../domain/types.js';

const AUTH = 'https://www.strava.com';
function apiBase() { return process.env.STRAVA_API_BASE || 'https://www.strava.com/api/v3'; }
const PORT = 37541;
interface RateBudget { shortLimit:number; dayLimit:number; shortUsed:number; dayUsed:number; }

export class RateLimitPause extends Error {
  constructor(message: string) { super(message); this.name = 'RateLimitPause'; }
}

export function readCredentials() {
  const id = process.env.STRAVA_CLIENT_ID;
  const secret = process.env.STRAVA_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in .env (see README).');
  return { id, secret };
}

export function hasToken(home: string) { return existsSync(join(home, 'token.json')); }
function saveToken(home: string, token: StravaToken) {
  const path = join(home, 'token.json');
  writeFileSync(path, JSON.stringify(token, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** A malformed token response should fail closed rather than writing unusable credentials. */
function isStravaToken(value: unknown): value is StravaToken {
  if (!value || typeof value !== 'object') return false;
  const token = value as Partial<StravaToken>;
  return typeof token.access_token === 'string'
    && typeof token.refresh_token === 'string'
    && typeof token.expires_at === 'number'
    && Number.isFinite(token.expires_at);
}

async function tokenRequest(form: Record<string,string>, fetchFn: typeof fetch = fetch): Promise<StravaToken> {
  const response = await fetchFn(`${AUTH}/oauth/token`, {
    method: 'POST',
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(30_000),
  });
  const json: unknown = await response.json();
  if (!response.ok) {
    const message = json && typeof json === 'object' && 'message' in json
      ? String(json.message)
      : JSON.stringify(json);
    throw new Error(`Strava authentication failed (${response.status}): ${message}`);
  }
  if (!isStravaToken(json)) throw new Error('Strava returned a malformed OAuth token response.');
  return json;
}

export async function authorize(home: string) {
  const { id, secret } = readCredentials();
  const state = randomBytes(20).toString('hex');
  const redirect = `http://localhost:${PORT}/callback`;
  const url = new URL(`${AUTH}/oauth/authorize`);
  Object.entries({ client_id: id, redirect_uri: redirect, response_type: 'code', approval_prompt: 'force', scope: 'activity:read_all,activity:write', state })
    .forEach(([key,value]) => url.searchParams.set(key,value));

  let done!: () => void;
  let fail!: (error: Error) => void;
  const completion = new Promise<void>((resolve,reject) => { done=resolve; fail=reject; });
  const server = createServer(async (req,res) => {
    try {
      const query = new URL(req.url ?? '/', redirect);
      if (query.pathname !== '/callback') { res.writeHead(404).end('Not found'); return; }
      if (query.searchParams.get('state') !== state) throw new Error('OAuth state mismatch');
      if (query.searchParams.get('error')) throw new Error(`Strava authorization rejected: ${query.searchParams.get('error')}`);
      const code = query.searchParams.get('code');
      const scope = query.searchParams.get('scope') ?? '';
      if (!code) throw new Error('No authorization code returned');
      for (const required of ['activity:read_all', 'activity:write']) {
        if (!scope.split(',').includes(required) && !scope.split(' ').includes(required)) throw new Error(`Strava scope ${required} not approved`);
      }
      const token = await tokenRequest({ client_id: id, client_secret: secret, code, grant_type: 'authorization_code' });
      saveToken(home, token);
      res.writeHead(200, {'content-type':'text/html; charset=utf-8'}).end('<h2>Strava connected. You can close this tab.</h2>');
      done();
    } catch(err) {
      res.writeHead(400, {'content-type':'text/plain; charset=utf-8'}).end(`Authorization failed: ${err instanceof Error ? err.message : String(err)}`);
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  });
  try {
    await new Promise<void>((resolve,reject) => {
      server.once('error', reject);
      server.listen(PORT, 'localhost', () => resolve());
    });
    console.log('\nOpen this link to connect Strava:\n' + url.toString() + '\n');
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c','start','',url.toString()] : [url.toString()];
    const child = spawn(cmd, args, { stdio:'ignore' });
    child.on('error', () => {});
    child.unref();
    const timeout = setTimeout(() => fail(new Error('OAuth timed out after 3 minutes')), 180000);
    try { await completion; } finally { clearTimeout(timeout); }
  } finally {
    server.close();
  }
}

interface StravaToken { access_token: string; refresh_token: string; expires_at: number; }
export class StravaClient {
  readonly home: string;
  private readonly fetchFn: typeof fetch;
  private token: StravaToken | null;
  private readonly budgets: { general: RateBudget | null; read: RateBudget | null };
  constructor(home: string, fetchFn: typeof fetch = fetch) {
    this.home = home;
    this.fetchFn = fetchFn;
    const saved: unknown = hasToken(home)
      ? JSON.parse(readFileSync(join(home, 'token.json'), 'utf8'))
      : null;
    if (saved !== null && !isStravaToken(saved)) {
      throw new Error('Saved Strava OAuth token is invalid; run auth again.');
    }
    this.token = saved;
    this.budgets = { general: null, read: null } as { general: RateBudget | null; read: RateBudget | null };
  }

  async accessToken(): Promise<string> {
    if (!this.token) throw new Error('Not connected to Strava. Run: node src/cli.mjs auth');
    if (this.token.expires_at > Math.floor(Date.now()/1000)+120) return this.token.access_token;
    const { id, secret } = readCredentials();
    this.token = await tokenRequest({ client_id:id, client_secret:secret, refresh_token:this.token.refresh_token, grant_type:'refresh_token' }, this.fetchFn);
    saveToken(this.home, this.token);
    return this.token.access_token;
  }

  enforceBudget(isRead: boolean) {
    const now = new Date();
    for (const budget of [this.budgets.general, isRead ? this.budgets.read : null]) {
      if (!budget) continue;
      // Reserve a handful of calls; stop before 429 and resume later.
      if (budget.shortUsed >= budget.shortLimit - 3) {
        const next = new Date(now);
        next.setUTCMinutes(Math.floor(now.getUTCMinutes()/15)*15+15, 0, 0);
        throw new RateLimitPause(`Strava 15-minute request budget nearly exhausted. Resume after ${next.toISOString()}.`);
      }
      if (budget.dayUsed >= budget.dayLimit - 5) {
        const next = new Date(now);
        next.setUTCHours(24,0,0,0);
        throw new RateLimitPause(`Strava daily request budget nearly exhausted. Resume after ${next.toISOString()}.`);
      }
    }
  }

  readBudgets(headers: Headers) {
    for (const [key, kind] of [['X-RateLimit-', 'general'],['X-ReadRateLimit-', 'read']] as const) {
      const limits = headers.get(`${key}Limit`)?.split(',').map(Number);
      const usages = headers.get(`${key}Usage`)?.split(',').map(Number);
      if (limits?.length === 2 && usages?.length === 2 && limits.every(Number.isFinite) && usages.every(Number.isFinite)) {
        this.budgets[kind] = { shortLimit:limits[0], dayLimit:limits[1], shortUsed:usages[0], dayUsed:usages[1] };
      }
    }
  }

  async request<T>(method: 'GET' | 'POST', path: string, body: BodyInit | undefined = undefined, { upload = false }: {upload?:boolean} = {}): Promise<T> {
    const isRead = method !== 'POST' || !path.startsWith('/uploads');
    this.enforceBudget(isRead);
    const access = await this.accessToken();
    let response;
    try {
      response = await this.fetchFn(`${apiBase()}${path}`, {
        method, headers: { Authorization: `Bearer ${access}` }, signal: AbortSignal.timeout(30_000), ...(body ? { body } : {})
      });
    } catch (err) {
      // A POST may have succeeded server-side; don't automatically submit twice.
      if (upload) throw new Error(`Upload outcome unknown (network failure): ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
    this.readBudgets(response.headers);
    if (response.status === 429) throw new RateLimitPause('Strava returned HTTP 429. Wait for the current rate-limit window and resume.');
    const text = await response.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : {}; }
    catch { json = { message: text.slice(0, 500) }; }
    if (!response.ok) {
      const body = json && typeof json === 'object' ? json as Record<string, unknown> : {};
      const desc = String(body.message ?? body.error ?? JSON.stringify(json).slice(0, 500));
      const err = Object.assign(new Error(`Strava API ${response.status}: ${desc}`), { status: response.status });
      throw err;
    }
    return json as T;
  }

  activities(page: number): Promise<StravaActivitySummary[]> { return this.request<StravaActivitySummary[]>('GET', `/athlete/activities?per_page=100&page=${page}`); }
  activityDetail(id: string): Promise<StravaActivityDetail> {
    if (!/^[0-9]+$/.test(String(id))) throw new Error('Invalid Strava activity ID');
    return this.request<StravaActivityDetail>('GET', `/activities/${id}`);
  }
  upload(file: { path:string; digest:string; format:string }): Promise<StravaUploadResponse> {
    const form = new FormData();
    const b = readFileSync(file.path);
    form.set('file', new Blob([b]), `garmin-${file.digest}.${file.format}`);
    form.set('data_type', file.format);
    form.set('external_id', `garmin-migrate-${file.digest.slice(0,32)}`);
    return this.request<StravaUploadResponse>('POST', '/uploads', form, { upload: true });
  }
  uploadStatus(id: string): Promise<StravaUploadResponse> { return this.request<StravaUploadResponse>('GET', `/uploads/${encodeURIComponent(id)}`); }
}

