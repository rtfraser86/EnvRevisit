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
import { EnvAlign, hasNativeV2, type RegisterResult } from '../../modules/env-align/src';
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Asset } from 'expo-media-library';

import { getReference, listCaptures, parseMarkers, setAlignment, type Capture, type MaskRect } from './db';
import { guidanceFromHomography, plausibleGuidance, type ImageGuidance } from './live-match';
import { fitFromPairs } from './tiepoints';

export const alignmentAvailable = EnvAlign != null;
/** Tie points, change map, zip / time-lapse export and video matching need the newer native build. */
export const nativeV2 = hasNativeV2;
export const NEEDS_REBUILD = 'This needs the latest EnvRevisit build. Run the build again and install it.';

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
export async function prepare(uri: string, long: number) {
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
      // Photos aligned by hand keep their tie points (as long as they still match the reference).
      if (cap.align_manual) {
        const byHand = await alignByMarkers(stationId, cap.id);
        if (byHand.ok) {
          p.ok++;
          p.done++;
          onProgress?.({ ...p });
          continue;
        }
      }
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

// ---------------------------------------------------------------------------------------------
// Ghost helpers for the capture screen

/** Outline (edge) image of a photo, cached per capture. White lines on transparent → tint in the UI. */
export async function edgesFor(cap: Capture): Promise<string | null> {
  if (!EnvAlign) return null;
  const f = new File(alignedDir(), `edges_c${cap.id}.png`);
  if (f.exists) return f.uri;
  const src = await prepare(cap.uri, 1600);
  try {
    const res = await EnvAlign.edges(src.uri, f.uri, 1600);
    return res.ok ? res.uri : null;
  } finally {
    deleteFile(src.uri);
  }
}

/** Small upright copy of the ghost photo for live matching (delete it when done). */
export async function ghostForMatching(cap: Capture): Promise<string> {
  const r = await prepare(cap.uri, 1024);
  return r.uri;
}

export type LiveMatch = { ok: true; g: ImageGuidance; at: number } | { ok: false; reason: string; at: number };

function toLiveMatch(r: RegisterResult, hfov: number, vfov: number): LiveMatch {
  const at = Date.now();
  if (!r.ok) return { ok: false, reason: r.reason, at };
  const g = guidanceFromHomography(r.h, r.width, r.height, hfov, vfov, r.diffBefore, r.diffAfter);
  if (!g || !plausibleGuidance(g) || g.quality < 8) return { ok: false, reason: 'No confident match', at };
  return { ok: true, g, at };
}

/** Register one still camera frame against the ghost and turn it into guidance. */
export async function matchLiveFrame(ghostUri: string, frameUri: string, hfov: number, vfov: number): Promise<LiveMatch> {
  if (!EnvAlign) return { ok: false, reason: 'Needs the EnvRevisit build', at: Date.now() };
  return toLiveMatch(await EnvAlign.register(ghostUri, frameUri, 640), hfov, vfov);
}

export const videoMatchAvailable = typeof EnvAlign?.liveMatch === 'function';

/**
 * Register the camera's newest video frame against the ghost (no still photo taken).
 * reason 'no-camera' means the native side couldn't attach to the camera.
 */
export async function matchVideoFrame(
  ghostUri: string,
  hold: 'portrait' | 'cw' | 'ccw',
  hfov: number,
  vfov: number
): Promise<LiveMatch> {
  if (!EnvAlign?.liveMatch) return { ok: false, reason: 'no-camera', at: Date.now() };
  return toLiveMatch(await EnvAlign.liveMatch(ghostUri, hold, 640), hfov, vfov);
}

export function stopVideoMatching() {
  EnvAlign?.liveStop?.().catch(() => {});
}

/** Blend a new match with the previous one so the readout doesn't jitter. */
export function smoothMatch(prev: LiveMatch | null, next: LiveMatch, k = 0.55): LiveMatch {
  // One missed frame (blur, a hand in the way) shouldn't drop the guidance back to the compass:
  // keep the last good match for a moment.
  if (!next.ok) return prev?.ok && next.at - prev.at < 800 ? prev : next;
  if (!prev?.ok || next.at - prev.at > 1500) return next;
  const mix = (a: number, b: number) => a + k * (b - a);
  const p = prev.g;
  const n = next.g;
  return {
    ...next,
    g: {
      turn: mix(p.turn, n.turn),
      tilt: mix(p.tilt, n.tilt),
      rotate: mix(p.rotate, n.rotate),
      scale: mix(p.scale, n.scale),
      quality: n.quality,
      ringX: mix(p.ringX, n.ringX),
      ringY: mix(p.ringY, n.ringY),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Tie-point alignment

/**
 * Align a photo to the reference using markers: the photo's markers must be the same features,
 * in the same order, as the reference's. Used when automatic alignment fails or isn't good enough.
 */
export async function alignByMarkers(stationId: number, captureId: number): Promise<AlignResult> {
  if (!EnvAlign?.warp) return { ok: false, reason: NEEDS_REBUILD, score: 0 };
  const ref = await getReference(stationId);
  const cap = (await listCaptures(stationId)).find((x) => x.id === captureId);
  if (!ref || !cap) return { ok: false, reason: 'Photo not found', score: 0 };
  const rp = parseMarkers(ref);
  const mp = parseMarkers(cap);
  if (rp.length < 2) return { ok: false, reason: 'Add at least 2 markers to the reference photo first (4 or more is best).', score: 0 };
  if (mp.length !== rp.length) {
    return { ok: false, reason: `Mark the same ${rp.length} features on this photo (it has ${mp.length}).`, score: 0 };
  }
  const [R, M] = await Promise.all([prepare(ref.uri, OUTPUT_LONG), prepare(cap.uri, OUTPUT_LONG)]);
  try {
    const src = mp.map((p) => ({ x: p.x * M.width, y: p.y * M.height }));
    const dst = rp.map((p) => ({ x: p.x * R.width, y: p.y * R.height }));
    const fit = fitFromPairs(src, dst, M.width, M.height);
    if (!fit || fit.rms > 0.02 * Math.max(R.width, R.height)) {
      return {
        ok: false,
        reason: "The markers don't line up consistently. Check each number is on the same feature in both photos.",
        score: 0,
      };
    }
    const out = new File(alignedDir(), `st${cap.station_id}_c${cap.id}_${Date.now()}.jpg`);
    const res = await EnvAlign.warp(M.uri, out.uri, fit.H, R.width, R.height);
    if (!res.ok) return { ok: false, reason: res.reason, score: 0 };
    if (!ref.aligned_uri) await setAlignment(ref.id, await referenceCopy(ref), 'ok', null);
    deleteFile(cap.aligned_uri);
    await setAlignment(cap.id, res.uri, 'ok', null, true);
    return { ok: true, uri: res.uri, score: 100 };
  } finally {
    deleteFile(R.uri);
    deleteFile(M.uri);
  }
}

// ---------------------------------------------------------------------------------------------
// Change map and time-lapse

export type ChangeMap = { ok: true; uri: string; changed: number } | { ok: false; reason: string };

/** White-on-transparent map of where two aligned photos differ (tint it in the UI). */
export async function changeMapFor(a: Capture, b: Capture, mask: MaskRect[] = []): Promise<ChangeMap> {
  if (!EnvAlign?.changeMap) return { ok: false, reason: NEEDS_REBUILD };
  if (mask.length && !EnvAlign.changeMapMasked) return { ok: false, reason: NEEDS_REBUILD };
  if (!a.aligned_uri || !b.aligned_uri) {
    return { ok: false, reason: 'Both photos need to be aligned first (station screen → Align).' };
  }
  const out = new File(Paths.cache, `change_${a.id}_${b.id}_${Date.now()}.png`);
  const res =
    mask.length && EnvAlign.changeMapMasked
      ? await EnvAlign.changeMapMasked(a.aligned_uri, b.aligned_uri, out.uri, 1280, mask.map((r) => [r.x, r.y, r.w, r.h]))
      : await EnvAlign.changeMap(a.aligned_uri, b.aligned_uri, out.uri, 1280);
  return res.ok ? { ok: true, uri: res.uri, changed: res.changed } : res;
}

/**
 * Time-lapse of a station as an MP4 or GIF, one photo per step, each labelled with its date.
 * Uses aligned copies where they exist (and `aligned` is on).
 */
export async function exportTimelapse(
  caps: Capture[],
  labels: string[],
  format: 'mp4' | 'gif',
  name: string,
  aligned: boolean
): Promise<{ ok: true; uri: string } | { ok: false; reason: string }> {
  if (!EnvAlign?.timelapse) return { ok: false, reason: NEEDS_REBUILD };
  const temp: string[] = [];
  try {
    const frames: string[] = [];
    for (const cap of caps) {
      if (aligned && cap.aligned_uri) frames.push(cap.aligned_uri);
      else {
        const r = await prepare(cap.uri, 1920);
        temp.push(r.uri);
        frames.push(r.uri);
      }
    }
    const out = new File(Paths.cache, `${name}.${format}`);
    const res = await EnvAlign.timelapse(frames, labels, out.uri, format, format === 'gif' ? 720 : 1920, format === 'gif' ? 0.8 : 1.2);
    return res.ok ? { ok: true, uri: res.uri } : res;
  } finally {
    temp.forEach(deleteFile);
  }
}

export { deleteFile };

/** Zoom range of the live camera (EnvRevisit build v3), or null. */
export async function cameraZoomRange(): Promise<{ min: number; max: number } | null> {
  if (!EnvAlign?.zoomRange) return null;
  try {
    const r = await EnvAlign.zoomRange();
    return r.ok && r.max > r.min ? { min: r.min, max: r.max } : null;
  } catch {
    return null;
  }
}

/** expo-camera's zoom prop (0–1) for an extra magnification on top of the lens. */
export function zoomPropFor(extra: number, range: { min: number; max: number } | null): number {
  if (!range || extra <= 1.001) return 0;
  return Math.max(0, Math.min(1, Math.log(extra) / Math.log(range.max / range.min)));
}
