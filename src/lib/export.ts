import { Directory, File, Paths } from 'expo-file-system';
import { Asset } from 'expo-media-library';
import * as Sharing from 'expo-sharing';

import { EnvAlign } from '../../modules/env-align/src';
import { NEEDS_REBUILD } from './align';
import { listCaptures, parseMarkers, type Station } from './db';

const pad = (v: number) => String(v).padStart(2, '0');
/** 20261113_0915 (local time) — sorts by date in any file browser. */
const stampName = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
};
const csvCell = (v: unknown) => {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const safeName = (name: string, fallback: string) => name.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || fallback;

export type ExportResult = { ok: true; uri: string; photos: number; missing: number } | { ok: false; reason: string };

/**
 * Everything about a station in one zip, laid out for scripts:
 *
 *   <Station>/originals/20261113_0915_c12.jpg     as shot (HEIC stays HEIC)
 *   <Station>/aligned/20261113_0915_c12.jpg       warped onto the reference view (same size for all)
 *   <Station>/captures.csv                        one row per photo, with the file names
 *   <Station>/station.json                        the same plus markers, in JSON
 */
export async function exportStationZip(station: Station, onProgress?: (done: number, total: number) => void): Promise<ExportResult> {
  if (!EnvAlign?.zipFolder) return { ok: false, reason: NEEDS_REBUILD };
  const caps = await listCaptures(station.id);
  if (!caps.length) return { ok: false, reason: 'This station has no photos yet.' };

  const name = safeName(station.name, `station_${station.id}`);
  const root = new Directory(Paths.cache, 'export');
  if (root.exists) root.delete();
  const dir = new Directory(root, name);
  const originals = new Directory(dir, 'originals');
  const aligned = new Directory(dir, 'aligned');
  originals.create({ intermediates: true });
  aligned.create({ intermediates: true });

  const header = [
    'station_id', 'station_name', 'capture_id', 'taken_at_utc', 'taken_at_local', 'source', 'is_reference',
    'original_file', 'aligned_file', 'align_status', 'lat', 'lon', 'gps_accuracy_m', 'heading_deg', 'pitch_deg',
    'roll_deg', 'width', 'height', 'orientation', 'lens', 'note1', 'note2', 'markers',
  ];
  const rows: string[] = [header.join(',')];
  const json: Record<string, unknown>[] = [];
  let missing = 0;
  let done = 0;

  for (const c of caps) {
    const base = `${stampName(c.taken_at)}_c${c.id}`;
    let originalFile = '';
    let alignedFile = '';
    try {
      const src = c.uri.startsWith('ph://') ? await new Asset(c.uri).getUri() : c.uri;
      const ext = (src.split('?')[0].match(/\.([A-Za-z0-9]{2,5})$/)?.[1] ?? 'jpg').toLowerCase();
      originalFile = `originals/${base}.${ext}`;
      await new File(src).copy(new File(originals, `${base}.${ext}`));
    } catch (e) {
      console.warn('export: original missing', c.id, e);
      originalFile = '';
      missing++;
    }
    if (c.aligned_uri && c.align_status === 'ok') {
      try {
        await new File(c.aligned_uri).copy(new File(aligned, `${base}.jpg`));
        alignedFile = `aligned/${base}.jpg`;
      } catch (e) {
        console.warn('export: aligned missing', c.id, e);
      }
    }
    const markers = parseMarkers(c);
    const local = new Date(c.taken_at);
    const record = {
      station_id: station.id,
      station_name: station.name,
      capture_id: c.id,
      taken_at_utc: local.toISOString(),
      taken_at_local: `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())} ${pad(local.getHours())}:${pad(local.getMinutes())}`,
      source: c.source,
      is_reference: c.is_reference,
      original_file: originalFile,
      aligned_file: alignedFile,
      align_status: c.align_status ?? '',
      lat: c.lat,
      lon: c.lon,
      gps_accuracy_m: c.accuracy,
      heading_deg: c.heading,
      pitch_deg: c.pitch,
      roll_deg: c.roll,
      width: c.width,
      height: c.height,
      orientation: c.orientation,
      lens: c.lens ?? '',
      note1: c.note1 ?? '',
      note2: c.note2 ?? '',
    };
    rows.push([...header.slice(0, -1).map((k) => csvCell((record as Record<string, unknown>)[k])), csvCell(markers.length ? JSON.stringify(markers) : '')].join(','));
    json.push({ ...record, markers });
    onProgress?.(++done, caps.length);
  }

  const csv = new File(dir, 'captures.csv');
  csv.create();
  await csv.write(rows.join('\n'));
  const meta = new File(dir, 'station.json');
  meta.create();
  await meta.write(
    JSON.stringify(
      {
        app: 'EnvRevisit',
        exported_at: new Date().toISOString(),
        station: {
          id: station.id,
          name: station.name,
          lat: station.lat,
          lon: station.lon,
          heading_deg: station.heading,
          pitch_deg: station.pitch,
          roll_deg: station.roll,
          orientation: station.orientation,
        },
        notes: {
          aligned: 'Photos in aligned/ are warped onto the reference photo and all share its size (long side 2048 px).',
          markers: 'Marker x/y are fractions of the upright photo, origin top-left.',
        },
        captures: json,
      },
      null,
      2
    )
  );

  const zip = new File(Paths.cache, `${name}_${stampName(Date.now())}.zip`);
  const res = await EnvAlign.zipFolder(dir.uri, zip.uri);
  try {
    root.delete();
  } catch {}
  if (!res.ok) return res;
  return { ok: true, uri: res.uri, photos: caps.length - missing, missing };
}

export async function shareFile(uri: string, mimeType: string, UTI: string) {
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType, UTI });
}
