import * as SQLite from 'expo-sqlite';

/**
 * Local database.
 *
 * - photos:   index of geotagged camera-roll photos (rebuilt/extended by scanning the library)
 * - stations: a monitoring point — where to stand and which way to look
 * - captures: every photo in a station's time series (from the camera roll or taken in-app)
 */

export type PhotoRow = {
  id: string; // ph://… asset id, usable directly as an expo-image source
  lat: number;
  lon: number;
  created: number; // ms since epoch
  width: number | null;
  height: number | null;
};

export type Station = {
  id: number;
  name: string;
  lat: number;
  lon: number;
  heading: number | null; // camera bearing, degrees true
  pitch: number | null; // camera elevation, degrees (+ up)
  roll: number | null; // horizon tilt, degrees (+ clockwise)
  notes: string | null;
  created: number;
};

export type Capture = {
  id: number;
  station_id: number;
  uri: string; // ph://… or file://…
  source: 'library' | 'app';
  taken_at: number;
  lat: number | null;
  lon: number | null;
  accuracy: number | null;
  heading: number | null;
  pitch: number | null;
  roll: number | null;
  width: number | null;
  height: number | null;
  is_reference: number; // 0/1
};

export type StationWithStats = Station & {
  n: number;
  first: number | null;
  last: number | null;
  ref_uri: string | null;
};

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync('revisit.db');
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS photos (
          id TEXT PRIMARY KEY NOT NULL,
          lat REAL NOT NULL,
          lon REAL NOT NULL,
          created INTEGER NOT NULL,
          width INTEGER,
          height INTEGER
        );
        CREATE INDEX IF NOT EXISTS photos_latlon ON photos(lat, lon);
        CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY NOT NULL, v TEXT);
        CREATE TABLE IF NOT EXISTS stations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          lat REAL NOT NULL,
          lon REAL NOT NULL,
          heading REAL,
          pitch REAL,
          roll REAL,
          notes TEXT,
          created INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS captures (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          station_id INTEGER NOT NULL REFERENCES stations(id) ON DELETE CASCADE,
          uri TEXT NOT NULL,
          source TEXT NOT NULL,
          taken_at INTEGER NOT NULL,
          lat REAL, lon REAL, accuracy REAL,
          heading REAL, pitch REAL, roll REAL,
          width INTEGER, height INTEGER,
          is_reference INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS captures_station ON captures(station_id, taken_at);
      `);
      return db;
    })();
  }
  return dbPromise;
}

// ---------- key/value ----------
export async function kvGet(k: string): Promise<string | null> {
  const db = await getDb();
  const r = await db.getFirstAsync<{ v: string }>('SELECT v FROM kv WHERE k = ?', k);
  return r?.v ?? null;
}
export async function kvSet(k: string, v: string) {
  const db = await getDb();
  await db.runAsync('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', k, v);
}

// ---------- photos ----------
export async function upsertPhotos(rows: PhotoRow[]) {
  if (!rows.length) return;
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    for (const r of rows) {
      await db.runAsync(
        'INSERT OR REPLACE INTO photos (id, lat, lon, created, width, height) VALUES (?, ?, ?, ?, ?, ?)',
        r.id, r.lat, r.lon, r.created, r.width, r.height
      );
    }
  });
}
export async function allPhotos(): Promise<PhotoRow[]> {
  const db = await getDb();
  return db.getAllAsync<PhotoRow>('SELECT * FROM photos ORDER BY created DESC');
}
export async function getPhoto(id: string): Promise<PhotoRow | null> {
  const db = await getDb();
  return db.getFirstAsync<PhotoRow>('SELECT * FROM photos WHERE id = ?', id);
}
export async function photosInBox(b: { minLat: number; maxLat: number; minLon: number; maxLon: number }) {
  const db = await getDb();
  return db.getAllAsync<PhotoRow>(
    'SELECT * FROM photos WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ? ORDER BY created DESC',
    b.minLat, b.maxLat, b.minLon, b.maxLon
  );
}
export async function clearPhotos() {
  const db = await getDb();
  await db.execAsync("DELETE FROM photos; DELETE FROM kv WHERE k = 'lastScan';");
}

// ---------- stations ----------
export async function createStation(s: Omit<Station, 'id' | 'created'>): Promise<number> {
  const db = await getDb();
  const r = await db.runAsync(
    'INSERT INTO stations (name, lat, lon, heading, pitch, roll, notes, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    s.name, s.lat, s.lon, s.heading, s.pitch, s.roll, s.notes, Date.now()
  );
  return r.lastInsertRowId;
}
export async function updateStation(id: number, patch: Partial<Omit<Station, 'id'>>) {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (!keys.length) return;
  const db = await getDb();
  await db.runAsync(
    `UPDATE stations SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    ...keys.map((k) => (patch[k] ?? null) as string | number | null),
    id
  );
}
export async function deleteStation(id: number) {
  const db = await getDb();
  await db.runAsync('DELETE FROM stations WHERE id = ?', id);
}
export async function getStation(id: number): Promise<Station | null> {
  const db = await getDb();
  return db.getFirstAsync<Station>('SELECT * FROM stations WHERE id = ?', id);
}
export async function listStations(): Promise<StationWithStats[]> {
  const db = await getDb();
  return db.getAllAsync<StationWithStats>(`
    SELECT s.*,
      (SELECT COUNT(*) FROM captures c WHERE c.station_id = s.id) AS n,
      (SELECT MIN(taken_at) FROM captures c WHERE c.station_id = s.id) AS first,
      (SELECT MAX(taken_at) FROM captures c WHERE c.station_id = s.id) AS last,
      (SELECT uri FROM captures c WHERE c.station_id = s.id
         ORDER BY is_reference DESC, taken_at ASC LIMIT 1) AS ref_uri
    FROM stations s ORDER BY s.created DESC`);
}

// ---------- captures ----------
export async function addCapture(c: Omit<Capture, 'id'>): Promise<number> {
  const db = await getDb();
  const r = await db.runAsync(
    `INSERT INTO captures (station_id, uri, source, taken_at, lat, lon, accuracy, heading, pitch, roll, width, height, is_reference)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    c.station_id, c.uri, c.source, c.taken_at, c.lat, c.lon, c.accuracy,
    c.heading, c.pitch, c.roll, c.width, c.height, c.is_reference
  );
  return r.lastInsertRowId;
}
export async function listCaptures(stationId: number): Promise<Capture[]> {
  const db = await getDb();
  return db.getAllAsync<Capture>(
    'SELECT * FROM captures WHERE station_id = ? ORDER BY taken_at ASC',
    stationId
  );
}
export async function getReference(stationId: number): Promise<Capture | null> {
  const db = await getDb();
  return db.getFirstAsync<Capture>(
    'SELECT * FROM captures WHERE station_id = ? ORDER BY is_reference DESC, taken_at ASC LIMIT 1',
    stationId
  );
}
export async function setReference(stationId: number, captureId: number) {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    await db.runAsync('UPDATE captures SET is_reference = 0 WHERE station_id = ?', stationId);
    await db.runAsync('UPDATE captures SET is_reference = 1 WHERE id = ?', captureId);
  });
}
export async function deleteCapture(id: number) {
  const db = await getDb();
  await db.runAsync('DELETE FROM captures WHERE id = ?', id);
}
export async function stationIdsForAsset(assetId: string): Promise<number[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ station_id: number }>(
    'SELECT DISTINCT station_id FROM captures WHERE uri = ?',
    assetId
  );
  return rows.map((r) => r.station_id);
}
