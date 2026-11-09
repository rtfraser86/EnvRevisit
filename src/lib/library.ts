import { Asset, AssetField, MediaType, Query } from 'expo-media-library';

import { kvGet, kvSet, upsertPhotos, type PhotoRow } from './db';

const PAGE = 400;
const CONCURRENCY = 24;

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

export type ScanProgress = { scanned: number; geotagged: number; done: boolean };

/**
 * Index geotagged photos from the camera roll into SQLite.
 * Incremental: only looks at photos newer than the last scan unless `full` is set.
 * Location lookups read PHAsset metadata only (no image decode), so this is fast.
 */
export async function scanLibrary(
  onProgress: (p: ScanProgress) => void,
  opts: { full?: boolean } = {}
): Promise<ScanProgress> {
  const since = opts.full ? 0 : Number((await kvGet('lastScan')) ?? 0);
  let offset = 0;
  let scanned = 0;
  let geotagged = 0;
  let newest = since;

  for (;;) {
    let q = new Query()
      .eq(AssetField.MEDIA_TYPE, MediaType.IMAGE)
      .orderBy({ key: AssetField.CREATION_TIME, ascending: true })
      .limit(PAGE)
      .offset(offset);
    if (since > 0) q = q.gt(AssetField.CREATION_TIME, since);
    const page = await q.exeForMetadata();
    if (!page.length) break;

    const rows = await mapLimit(page, CONCURRENCY, async (m): Promise<PhotoRow | null> => {
      try {
        const loc = await new Asset(m.id).getLocation();
        if (!loc || (loc.latitude === 0 && loc.longitude === 0)) return null;
        return {
          id: m.id,
          lat: loc.latitude,
          lon: loc.longitude,
          created: m.creationTime ?? 0,
          width: m.width,
          height: m.height,
        };
      } catch {
        return null;
      }
    });
    const good = rows.filter((r): r is PhotoRow => r !== null);
    await upsertPhotos(good);

    scanned += page.length;
    geotagged += good.length;
    for (const m of page) if (m.creationTime && m.creationTime > newest) newest = m.creationTime;
    onProgress({ scanned, geotagged, done: false });

    if (page.length < PAGE) break;
    offset += PAGE;
  }

  await kvSet('lastScan', String(newest));
  const result = { scanned, geotagged, done: true };
  onProgress(result);
  return result;
}

export type PhotoPose = {
  heading: number | null; // GPSImgDirection (camera bearing) if the camera recorded it
  headingRef: 'T' | 'M' | null;
  altitude: number | null;
  hAccuracy: number | null; // GPSHPositioningError, metres
  focalLength35: number | null;
  attitude: { pitch?: number; roll?: number; heading?: number } | null; // written by this app
};

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Read what the original photo knows about where it was pointed. */
export async function readPose(assetId: string): Promise<PhotoPose> {
  const pose: PhotoPose = {
    heading: null,
    headingRef: null,
    altitude: null,
    hAccuracy: null,
    focalLength35: null,
    attitude: null,
  };
  try {
    const exif = await new Asset(assetId).getExif();
    // iOS returns CGImageProperties-style nested dictionaries; be lenient about key spelling.
    const gps = exif['{GPS}'] ?? exif.GPS ?? {};
    const ex = exif['{Exif}'] ?? exif.Exif ?? exif;
    pose.heading = num(gps.ImgDirection ?? exif.GPSImgDirection);
    const ref = gps.ImgDirectionRef ?? exif.GPSImgDirectionRef;
    pose.headingRef = ref === 'T' || ref === 'M' ? ref : null;
    pose.altitude = num(gps.Altitude ?? exif.GPSAltitude);
    pose.hAccuracy = num(gps.HPositioningError ?? exif.GPSHPositioningError);
    pose.focalLength35 = num(ex.FocalLenIn35mmFilm ?? ex.FocalLengthIn35mmFilm);
    const comment = ex.UserComment;
    if (typeof comment === 'string' && comment.startsWith('{')) {
      try {
        const j = JSON.parse(comment);
        if (j && (j.app === 'envrevisit' || j.app === 'revisit')) pose.attitude = j;
      } catch {}
    }
  } catch {}
  return pose;
}

/** Portrait vs landscape from (displayed) pixel dimensions. */
export function orientationOf(w: number | null, h: number | null): 'portrait' | 'landscape' | null {
  if (!w || !h) return null;
  return w > h ? 'landscape' : 'portrait';
}
