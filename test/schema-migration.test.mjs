import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/persistence/store.js';

test('opens and upgrades an existing v0.2 SQLite database without clearing workouts', () => {
  const home = mkdtempSync(join(tmpdir(), 'g2s-old-state-'));
  try {
    const legacy = new DatabaseSync(join(home, 'migration.sqlite'));
    legacy.exec(`
      CREATE TABLE remote_activities (
        id TEXT PRIMARY KEY,
        start_utc INTEGER,
        duration_seconds REAL,
        distance_m REAL,
        sport TEXT
      );
      INSERT INTO remote_activities
      (id,start_utc,duration_seconds,distance_m,sport)
      VALUES ('12345',1700000000,3600,10000,'Run');
    `);
    legacy.close();

    const store = new Store(home);
    try {
      assert.equal(store.countRemote(), 1);
      assert.equal(store.remoteById('12345').distance_m, 10000);
      assert.equal(store.remoteById('12345').sport, 'Run');
      store.upsertRemote({
        id: 67890,
        name: 'Apple Watch Run',
        start_date: '2026-01-02T07:00:00Z',
        sport_type: 'Run',
        elapsed_time: 2100,
        distance: 5100,
        map: {summary_polyline: 'encoded-route'},
      });
      assert.equal(store.remoteById('67890').name, 'Apple Watch Run');
      assert.equal(store.remoteById('12345').id, '12345');
    } finally { store.close(); }

    const db = new DatabaseSync(join(home, 'migration.sqlite'));
    try {
      const columns = db.prepare('PRAGMA table_info(remote_activities)').all().map(row => row.name);
      for (const col of ['name','device_name','route_polyline','manual','moving_seconds','detail_fetched_at']) {
        assert.ok(columns.includes(col), `missing new column: ${col}`);
      }
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM remote_activities").get().n, 2);
    } finally { db.close(); }
  } finally { rmSync(home, {recursive:true,force:true}); }
});
