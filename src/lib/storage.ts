import { Directory, File, Paths } from 'expo-file-system';
import { Album, Asset } from 'expo-media-library';
import * as Sharing from 'expo-sharing';

import { listCaptures, type Capture, type Station } from './db';

const ALBUM = 'Revisit';

function capturesDir() {
  const dir = new Directory(Paths.document, 'captures');
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/**
 * Move a freshly-taken photo into the app's documents folder (the copy the app relies on),
 * and optionally also save a copy to the camera roll in a "Revisit" album.
 */
export async function persistCapture(
  tempUri: string,
  stationId: number,
  takenAt: number,
  alsoSaveToPhotos: boolean
): Promise<{ fileUri: string; assetId: string | null }> {
  const src = new File(tempUri);
  const dest = new File(capturesDir(), `st${stationId}_${takenAt}.jpg`);
  await src.copy(dest);
  try {
    src.delete();
  } catch {}

  let assetId: string | null = null;
  if (alsoSaveToPhotos) {
    try {
      const asset = await Asset.create(dest.uri);
      assetId = asset.id;
      const album = await Album.get(ALBUM);
      if (album) await album.add(asset);
      else await Album.create(ALBUM, [asset]);
    } catch (e) {
      console.warn('Could not save to Photos', e);
    }
  }
  return { fileUri: dest.uri, assetId };
}

export function deleteCaptureFile(c: Capture) {
  if (c.source !== 'app' || !c.uri.startsWith('file:')) return;
  try {
    const f = new File(c.uri);
    if (f.exists) f.delete();
  } catch {}
}

const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : '');
const n = (v: number | null, dp = 2) => (v === null || v === undefined ? '' : v.toFixed(dp));

/** CSV of every capture in a station — ready to join to your Python change-detection pipeline. */
export async function stationCsv(station: Station): Promise<string> {
  const caps = await listCaptures(station.id);
  const header =
    'station_id,station_name,capture_id,taken_at_utc,source,uri,lat,lon,gps_accuracy_m,heading_deg,pitch_deg,roll_deg,width,height,is_reference';
  const rows = caps.map((c) =>
    [
      station.id,
      JSON.stringify(station.name),
      c.id,
      iso(c.taken_at),
      c.source,
      JSON.stringify(c.uri),
      n(c.lat, 7),
      n(c.lon, 7),
      n(c.accuracy, 1),
      n(c.heading, 1),
      n(c.pitch, 1),
      n(c.roll, 1),
      c.width ?? '',
      c.height ?? '',
      c.is_reference,
    ].join(',')
  );
  return [header, ...rows].join('\n');
}

export async function shareStationCsv(station: Station) {
  const csv = await stationCsv(station);
  const safe = station.name.replace(/[^\w-]+/g, '_').slice(0, 40) || `station_${station.id}`;
  const f = new File(Paths.cache, `${safe}_captures.csv`);
  if (f.exists) f.delete();
  f.create();
  await f.write(csv);
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(f.uri, { mimeType: 'text/csv', UTI: 'public.comma-separated-values-text' });
  }
}
