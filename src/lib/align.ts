/**
 * Automatic photo registration (Stage 3).
 *
 * Each photo in a station is aligned to the station's reference photo by the local native
 * module `modules/env-align` (Apple Vision: VNHomographicImageRegistrationRequest, then a
 * CoreImage perspective warp into the reference frame, long side 2048 px).
 *
 * Originals are never changed — the aligned copy is stored next to them and the timeline can
 * show either. The native module only exists in the EnvRevisit build (not Expo Go);
 * `alignmentAvailable` tells the UI.
 */
import { EnvAlign } from '../../modules/env-align/src';
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Asset } from 'expo-media-library';

import { getReference, listCaptures, setAlignment, type Capture } from './db';

export const alignmentAvailable = EnvAlign != null;

const OUTPUT_LONG = 2048; // px, aligned copies

function alignedDir() {
  const d = new Directory(Paths.document, 'aligned');
  if (!d.exists) d.create({ intermediates: true });
  return d;
}

async function localUri(uri: string): Promise<string> {
  if (uri.startsWith('ph://')) return new Asset(uri).getUri();
  return uri;
}

/** Upright JPEG copy of the photo with its long side ≤ `long` px (EXIF orientation baked in). */
async function prepare(uri: string, long: number) {
  const src = await localUri(uri);
  const probe = await ImageManipulator.manipulate(src).renderAsync();
  const { width, height } = probe;
  const k = Math.min(1, long / Math.max(width, height));
  const ctx = ImageManipulator.manipulate(src);
  if (k < 1) ctx.resize(width >= height ? { width: Math.round(width * k) } : { height: Math.round(height * k) });
  const img = await ctx.renderAsync();
  return img.saveAsync({ format: SaveFormat.JPEG, compress: 0.92 });
}

export type AlignResult = { ok: true; uri: string; score: number } | { ok: false; reason: string; score: number };

/** Align one capture to a reference capture. Writes the aligned JPEG; does not touch the DB. */
export async function alignPair(ref: Capture, mov: Capture): Promise<AlignResult> {
  if (!EnvAlign) return { ok: false, reason: 'Alignment needs the EnvRevisit app build (not Expo Go).', score: 0 };
  // Normalise both inputs to upright JPEGs (handles ph:// assets, HEIC and iCloud originals).
  const [R, M] = await Promise.all([prepare(ref.uri, OUTPUT_LONG), prepare(mov.uri, OUTPUT_LONG)]);
  const out = new File(alignedDir(), `st${mov.station_id}_c${mov.id}_${Date.now()}.jpg`);
  try {
    const res = await EnvAlign.align(R.uri, M.uri, out.uri, OUTPUT_LONG);
    if (!res.ok) return { ok: false, reason: res.reason, score: 0 };
    // Score: how much closer the warped photo is to the reference than the unaligned one (0–100).
    const score = res.diffBefore > 0 ? Math.round(100 * Math.max(0, 1 - res.diffAfter / res.diffBefore)) : 0;
    if (res.diffAfter > res.diffBefore * 1.02) {
      deleteFile(out.uri);
      return { ok: false, reason: 'Alignment made the match worse', score };
    }
    return { ok: true, uri: res.uri, score };
  } finally {
    deleteFile(R.uri);
    deleteFile(M.uri);
  }
}

/** Resized copy of the reference, so every aligned frame in a station has the same size. */
async function referenceCopy(ref: Capture): Promise<string> {
  const r = await prepare(ref.uri, OUTPUT_LONG);
  const dest = new File(alignedDir(), `st${ref.station_id}_c${ref.id}_${Date.now()}.jpg`);
  await new File(r.uri).copy(dest);
  return dest.uri;
}

function deleteFile(uri: string | null | undefined) {
  if (!uri) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {}
}

/** Align one capture (and make sure the reference has its aligned copy). */
export async function alignCapture(stationId: number, captureId: number) {
  const ref = await getReference(stationId);
  if (!ref) return;
  const caps = await listCaptures(stationId);
  const cap = caps.find((x) => x.id === captureId);
  if (!cap) return;
  if (!ref.aligned_uri) {
    const u = await referenceCopy(ref);
    await setAlignment(ref.id, u, 'ok', null);
  }
  if (cap.id === ref.id) return;
  const res = await alignPair(ref, cap);
  deleteFile(cap.aligned_uri);
  await setAlignment(cap.id, res.ok ? res.uri : null, res.ok ? 'ok' : 'failed', res.score);
  return res;
}

export type AlignProgress = { done: number; total: number; ok: number; failed: number };

/** (Re-)align every photo in a station to its reference. */
export async function alignStation(stationId: number, onProgress?: (p: AlignProgress) => void) {
  const ref = await getReference(stationId);
  if (!ref) return { done: 0, total: 0, ok: 0, failed: 0 };
  const caps = await listCaptures(stationId);
  const p: AlignProgress = { done: 0, total: caps.length, ok: 0, failed: 0 };
  onProgress?.({ ...p });

  deleteFile(ref.aligned_uri);
  const refUri = await referenceCopy(ref);
  await setAlignment(ref.id, refUri, 'ok', null);
  p.done++;
  p.ok++;
  onProgress?.({ ...p });

  for (const cap of caps) {
    if (cap.id === ref.id) continue;
    try {
      const res = await alignPair(ref, cap);
      deleteFile(cap.aligned_uri);
      await setAlignment(cap.id, res.ok ? res.uri : null, res.ok ? 'ok' : 'failed', res.score);
      if (res.ok) p.ok++;
      else p.failed++;
    } catch (e) {
      console.warn('align failed', e);
      await setAlignment(cap.id, null, 'failed', 0);
      p.failed++;
    }
    p.done++;
    onProgress?.({ ...p });
  }
  return p;
}
