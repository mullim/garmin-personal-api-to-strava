import { DatabaseSync } from 'node:sqlite';
import type { GarminActivity, RemoteActivity, StravaActivityDetail, StravaActivitySummary, ActivityFileInput, FileRow, GarminRow } from '../domain/types.js';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function getHome() {
  return process.env.G2S_HOME || join(homedir(), '.garmin-api-to-strava');
}

export class Store {
  readonly home: string;
  private readonly db: DatabaseSync;
  constructor(home = getHome()) {
    this.home = home;
    mkdirSync(home, { recursive: true, mode: 0o700 });
    mkdirSync(join(home, 'activities'), { recursive: true, mode: 0o700 });
    const dbPath = join(home, 'migration.sqlite');
    this.db = new DatabaseSync(dbPath);
    chmodSync(dbPath, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS files (
        digest TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        original_path TEXT NOT NULL,
        format TEXT NOT NULL,
        start_utc INTEGER,
        duration_seconds REAL,
        distance_m REAL,
        sport TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        remote_activity_id TEXT,
        upload_id TEXT,
        error TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS remote_activities (
        id TEXT PRIMARY KEY,
        start_utc INTEGER,
        duration_seconds REAL,
        distance_m REAL,
        sport TEXT
      );
      CREATE INDEX IF NOT EXISTS remote_time ON remote_activities(start_utc);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS garmin_activities (
        id TEXT PRIMARY KEY,
        name TEXT,
        start_utc INTEGER,
        duration_seconds REAL,
        distance_m REAL,
        sport TEXT,
        file_digest TEXT,
        state TEXT NOT NULL DEFAULT 'pending',
        remote_activity_id TEXT,
        error TEXT,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS garmin_start ON garmin_activities(start_utc);
    `);
    // Additive schema migration: existing migration databases remain intact.
    const columns = new Set(this.db.prepare('PRAGMA table_info(remote_activities)').all().map(x => x.name));
    for (const [name, type] of [
      ['name','TEXT'],
      ['device_name','TEXT'],
      ['route_polyline','TEXT'],
      ['manual','INTEGER'],
      ['moving_seconds','REAL'],
      ['detail_fetched_at','TEXT'],
    ]) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE remote_activities ADD COLUMN ${name} ${type}`);
    }
  }

  close() { this.db.close(); }

  addGarmin(a: GarminActivity) {
    this.db.prepare(`INSERT INTO garmin_activities (id,name,start_utc,duration_seconds,distance_m,sport)
      VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, start_utc=excluded.start_utc,
      duration_seconds=excluded.duration_seconds, distance_m=excluded.distance_m,
      sport=excluded.sport, updated_at=datetime('now')`).run(
      a.id, a.name ?? null, a.startUtc ?? null, a.durationSeconds ?? null, a.distanceM ?? null,
      typeof a.sport === 'string' ? a.sport : null
    );
  }
  garminRows(): GarminRow[] {
    return this.db.prepare(`SELECT g.*, f.status AS file_status, f.remote_activity_id AS file_remote_id
      FROM garmin_activities g LEFT JOIN files f ON f.digest=g.file_digest
      ORDER BY g.start_utc ASC, g.id ASC`).all() as unknown as GarminRow[];
  }
  countGarmin(): number { return Number((this.db.prepare('SELECT COUNT(*) AS n FROM garmin_activities').get() as {n:number}|undefined)?.n ?? 0); }
  garminFile(id: string, digest: string) {
    this.db.prepare(`UPDATE garmin_activities SET file_digest=?,state='staged',error=NULL,updated_at=datetime('now') WHERE id=?`).run(digest, id);
  }
  resetGarminFailed() {
    this.db.exec("UPDATE garmin_activities SET state='pending',error=NULL WHERE state='failed'");
  }
  garminState(id: string, state: string, { remoteId = null, error = null }:{remoteId?:string|null;error?:string|null} = {}) {
    this.db.prepare(`UPDATE garmin_activities SET state=?,remote_activity_id=COALESCE(?,remote_activity_id),
      error=?,updated_at=datetime('now') WHERE id=?`).run(state,remoteId,error,id);
  }

  addFile(file: ActivityFileInput) {
    this.db.prepare(`INSERT INTO files
      (digest, path, original_path, format, start_utc, duration_seconds, distance_m, sport)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(digest) DO UPDATE SET
        path=excluded.path,
        original_path=excluded.original_path,
        start_utc=COALESCE(excluded.start_utc, files.start_utc),
        duration_seconds=COALESCE(excluded.duration_seconds, files.duration_seconds),
        distance_m=COALESCE(excluded.distance_m, files.distance_m),
        sport=COALESCE(excluded.sport, files.sport),
        updated_at=datetime('now')`).run(
      file.digest, file.path, file.originalPath, file.format,
      file.startUtc ?? null, file.durationSeconds ?? null, file.distanceM ?? null, file.sport ?? null
    );
  }

  fileByDigest(digest: string): FileRow | undefined { return this.db.prepare('SELECT * FROM files WHERE digest=?').get(digest) as unknown as FileRow | undefined; }

  files(statuses?: string[]): FileRow[] {
    if (!statuses?.length) return this.db.prepare('SELECT * FROM files ORDER BY start_utc ASC, original_path ASC').all() as unknown as FileRow[];
    const placeholders = statuses.map(() => '?').join(',');
    return this.db.prepare(`SELECT * FROM files WHERE status IN (${placeholders}) ORDER BY start_utc ASC, original_path ASC`).all(...statuses) as unknown as FileRow[];
  }

  updateFile(digest: string, status: string, fields: {remoteActivityId?:string|null;uploadId?:string|null;error?:string|null} = {}) {
    this.db.prepare(`UPDATE files SET status=?, remote_activity_id=COALESCE(?,remote_activity_id),
      upload_id=COALESCE(?,upload_id), error=?, updated_at=datetime('now') WHERE digest=?`)
      .run(status, fields.remoteActivityId ?? null, fields.uploadId ?? null, fields.error ?? null, digest);
  }

  resetFailed(includeUncertain = false) {
    this.db.exec(includeUncertain
      ? "UPDATE files SET status='pending', error=NULL, upload_id=NULL WHERE status IN ('failed','uncertain')"
      : "UPDATE files SET status='pending', error=NULL, upload_id=NULL WHERE status='failed'");
  }

  setMeta(key: string, value: string | number) {
    this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
  }
  getMeta(key: string): string | undefined { const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as {value: string}|undefined; return row?.value; }

  clearRemote() { this.db.exec('DELETE FROM remote_activities'); }
  upsertRemote(a: StravaActivitySummary) {
    this.db.prepare(`INSERT INTO remote_activities
      (id,start_utc,duration_seconds,distance_m,sport,name,route_polyline,manual,moving_seconds)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
      start_utc=excluded.start_utc, duration_seconds=excluded.duration_seconds,
      distance_m=excluded.distance_m, sport=excluded.sport,
      name=excluded.name,route_polyline=COALESCE(excluded.route_polyline,remote_activities.route_polyline),
      manual=excluded.manual, moving_seconds=excluded.moving_seconds`)
      .run(String(a.id_str ?? a.id), a.start_date ? Date.parse(a.start_date) / 1000 : null,
        a.elapsed_time ?? null, a.distance ?? null, a.sport_type ?? a.type ?? null,
        a.name ?? null, a.map?.summary_polyline ?? null, a.manual ? 1 : 0,
        a.moving_time ?? null);
  }
  remoteAll(): RemoteActivity[] {
    return this.db.prepare('SELECT * FROM remote_activities ORDER BY start_utc ASC').all() as unknown as RemoteActivity[];
  }
  remoteById(id: string): RemoteActivity | undefined {
    return this.db.prepare('SELECT * FROM remote_activities WHERE id=?').get(String(id)) as unknown as RemoteActivity | undefined;
  }
  updateRemoteDetail(id: string, detail: StravaActivityDetail) {
    this.db.prepare(`UPDATE remote_activities
      SET device_name=?,route_polyline=COALESCE(?,route_polyline),
      detail_fetched_at=datetime('now')
      WHERE id=?`).run(
      detail.device_name ?? null,
      detail.map?.polyline ?? detail.map?.summary_polyline ?? null,
      String(id)
    );
  }
  remoteNear(epoch: number | null): RemoteActivity[] {
    if (epoch == null) return [];
    return this.db.prepare('SELECT * FROM remote_activities WHERE start_utc BETWEEN ? AND ?').all(epoch - 3, epoch + 3) as unknown as RemoteActivity[];
  }
  countRemote(): number { return Number((this.db.prepare('SELECT COUNT(*) AS n FROM remote_activities').get() as {n:number}|undefined)?.n ?? 0); }
  counts(): Array<{status:string;count:number}> { return this.db.prepare('SELECT status, COUNT(*) AS count FROM files GROUP BY status ORDER BY status').all() as Array<{status:string;count:number}>; }
}
