/**
 * Automatic photo registration (Stage 3).
 *
 * Each photo in a station is aligned to the station's reference photo:
 *   1. downscale both to ~1024 px and detect ORB features (OpenCV)
 *   2. match descriptors (Hamming, k=2) and keep matches passing Lowe's ratio test
 *   3. fit a homography with RANSAC (pure JS, see homography.ts)
 *   4. warp a ~2048 px copy of the photo into the reference frame (OpenCV warpPerspective)
 *
 * Originals are never changed — the aligned copy is stored next to them and the timeline
 * can show either. OpenCV is a native module, so this only works in the EnvRevisit build
 * (not in Expo Go); `alignmentAvailable` tells the UI.
 */
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { Asset } from 'expo-media-library';

import { getReference, listCaptures, setAlignment, type Capture } from './db';
import { mul, plausible, ransacHomography, scale, type Pt } from './homography';

export const alignmentAvailable = Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;

type CVModule = typeof import('react-native-fast-opencv');
let cvModule: CVModule | null = null;
function cv(): CVModule {
  if (!alignmentAvailable) throw new Error('Alignment needs the EnvRevisit app build (not Expo Go).');
  if (!cvModule) {
    // Loaded lazily so the rest of the app still runs in Expo Go.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cvModule = require('react-native-fast-opencv') as CVModule;
  }
  return cvModule;
}

const FEATURE_LONG = 1024; // px, for feature detection
const OUTPUT_LONG = 2048; // px, aligned copies
const RATIO = 0.78; // Lowe ratio test
const MIN_INLIERS = 25;
const MIN_INLIER_RATIO = 0.15;

function alignedDir() {
  const d = new Directory(Paths.document, 'aligned');
  if (!d.exists) d.create({ intermediates: true });
  return d;
}

async function localUri(uri: string): Promise<string> {
  if (uri.startsWith('ph://')) return new Asset(uri).getUri();
  return uri;
}

/** Upright JPEG of the photo with its long side ≤ `long` px. EXIF orientation is baked in. */
async function prepare(uri: string, long: number, base64: boolean) {
  const src = await localUri(uri);
  const probe = await ImageManipulator.manipulate(src).renderAsync();
  const { width, height } = probe;
  const k = Math.min(1, long / Math.max(width, height));
  const ctx = ImageManipulator.manipulate(src);
  if (k < 1) ctx.resize(width >= height ? { width: Math.round(width * k) } : { height: Math.round(height * k) });
  const img = await ctx.renderAsync();
  const saved = await img.saveAsync({ format: SaveFormat.JPEG, compress: 0.92, base64 });
  return { uri: saved.uri, width: saved.width, height: saved.height, base64: saved.base64 ?? '' };
}

export type AlignResult =
  | { ok: true; uri: string; inliers: number; matches: number; rmse: number }
  | { ok: false; reason: string; inliers: number; matches: number };

/** Align one capture to a reference capture. Writes the aligned JPEG; does not touch the DB. */
export async function alignPair(ref: Capture, mov: Capture): Promise<AlignResult> {
  const m = cv();
  const { OpenCV, DataTypes, ColorConversionCodes, NormTypes, InterpolationFlags, BorderTypes } = m;
  const objs: { release(): void }[] = [];
  const keep = <T extends { release(): void }>(o: T) => {
    objs.push(o);
    return o;
  };

  try {
    const [R, M] = await Promise.all([prepare(ref.uri, FEATURE_LONG, true), prepare(mov.uri, FEATURE_LONG, true)]);

    const gray = (b64: string) => {
      const color = keep(OpenCV.Mat.createFromBase64(b64));
      const g = keep(OpenCV.Mat.create(color.rows, color.cols, DataTypes.CV_8U));
      OpenCV.cvtColor(color, g, ColorConversionCodes.COLOR_BGR2GRAY);
      return g;
    };
    const gR = gray(R.base64);
    const gM = gray(M.base64);

    const orb = keep(OpenCV.ORB_create(4000));
    const fR = OpenCV.detectAndCompute(orb, gR);
    const fM = OpenCV.detectAndCompute(orb, gM);
    keep(fR.keypoints);
    keep(fR.descriptors);
    keep(fM.keypoints);
    keep(fM.descriptors);
    if (fR.keypoints.length < 20 || fM.keypoints.length < 20) {
      return { ok: false, reason: 'Too few features (blank or blurry photo?)', inliers: 0, matches: 0 };
    }

    const matcher = keep(OpenCV.BFMatcher_create(NormTypes.NORM_HAMMING, false));
    const knnVec = keep(OpenCV.knnMatchBF(matcher, fM.descriptors, fR.descriptors, 2));
    const knn = knnVec.toArray();
    const kR = fR.keypoints.toArray();
    const kM = fM.keypoints.toArray();

    const src: Pt[] = [];
    const dst: Pt[] = [];
    for (const pair of knn) {
      if (pair.length < 2) continue;
      const [a, b] = pair;
      if (a.distance < RATIO * b.distance) {
        const pm = kM[a.queryIdx];
        const pr = kR[a.trainIdx];
        if (pm && pr) {
          src.push({ x: pm.x, y: pm.y });
          dst.push({ x: pr.x, y: pr.y });
        }
      }
    }
    if (src.length < MIN_INLIERS) {
      return { ok: false, reason: 'Not enough matching detail between the photos', inliers: 0, matches: src.length };
    }

    const fit = ransacHomography(src, dst, { threshold: 4, iterations: 2000 });
    if (!fit || fit.inliers.length < MIN_INLIERS || fit.inliers.length / src.length < MIN_INLIER_RATIO) {
      return {
        ok: false,
        reason: 'Could not find a consistent alignment',
        inliers: fit?.inliers.length ?? 0,
        matches: src.length,
      };
    }
    if (!plausible(fit.H)) {
      return { ok: false, reason: 'Alignment looked implausible', inliers: fit.inliers.length, matches: src.length };
    }

    // Output: reference frame at OUTPUT_LONG; source: moving photo at OUTPUT_LONG.
    const kOut = Math.min(1, OUTPUT_LONG / Math.max(ref.width ?? R.width, ref.height ?? R.height));
    const [Ro, Mo] = await Promise.all([
      Promise.resolve({ width: Math.round((ref.width ?? R.width) * kOut), height: Math.round((ref.height ?? R.height) * kOut) }),
      prepare(mov.uri, OUTPUT_LONG, true),
    ]);
    // H maps moving@feature px → ref@feature px. Compose: moving@output → ref@output.
    const W = mul(scale(Ro.width / R.width), mul(fit.H, scale(M.width / Mo.width)));

    const srcMat = keep(OpenCV.Mat.createFromBase64(Mo.base64));
    const Hmat = keep(OpenCV.Mat.create(3, 3, DataTypes.CV_64F, W));
    const out = keep(OpenCV.Mat.create(Ro.height, Ro.width, DataTypes.CV_8UC3));
    const size = keep(OpenCV.Size.create(Ro.width, Ro.height));
    const border = keep(OpenCV.Scalar.create(0, 0, 0, 255));
    OpenCV.warpPerspective(
      srcMat,
      out,
      Hmat,
      size,
      InterpolationFlags.INTER_LINEAR,
      BorderTypes.BORDER_CONSTANT,
      border
    );

    const file = new File(alignedDir(), `st${mov.station_id}_c${mov.id}_${Date.now()}.jpg`);
    out.saveToFile(file.uri, 'jpeg', 0.9);
    return { ok: true, uri: file.uri, inliers: fit.inliers.length, matches: src.length, rmse: fit.rmse };
  } finally {
    for (const o of objs.reverse()) {
      try {
        o.release();
      } catch {}
    }
  }
}

/** Resized copy of the reference, so every aligned frame in a station has the same size. */
async function referenceCopy(ref: Capture): Promise<string> {
  const r = await prepare(ref.uri, OUTPUT_LONG, false);
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
  await setAlignment(cap.id, res.ok ? res.uri : null, res.ok ? 'ok' : 'failed', res.inliers);
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
      await setAlignment(cap.id, res.ok ? res.uri : null, res.ok ? 'ok' : 'failed', res.inliers);
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
