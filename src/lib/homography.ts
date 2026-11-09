/**
 * Pure-JS homography estimation (DLT + RANSAC).
 *
 * The iOS OpenCV build used by react-native-fast-opencv has no calib3d, so there's no
 * findHomography. This does the same job: robustly fit H such that dst ≈ H · src.
 * H is a row-major 3×3 array [h11 h12 h13 h21 h22 h23 h31 h32 h33] with h33 = 1.
 */

export type Pt = { x: number; y: number };
export type H3 = number[]; // length 9

/** Solve A·x = b (n×n) by Gaussian elimination with partial pivoting. Returns null if singular. */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

/** Similarity transform that moves points to centroid 0 and mean distance √2 (Hartley). */
function normaliser(pts: Pt[]) {
  let cx = 0;
  let cy = 0;
  for (const p of pts) {
    cx += p.x;
    cy += p.y;
  }
  cx /= pts.length;
  cy /= pts.length;
  let d = 0;
  for (const p of pts) d += Math.hypot(p.x - cx, p.y - cy);
  d /= pts.length;
  const s = d > 1e-9 ? Math.SQRT2 / d : 1;
  return { s, cx, cy };
}

/** Least-squares DLT from ≥4 correspondences (dst ≈ H·src). */
export function fitHomography(src: Pt[], dst: Pt[]): H3 | null {
  const n = src.length;
  if (n < 4) return null;
  const ns = normaliser(src);
  const nd = normaliser(dst);
  // Normal equations AᵀA h = Aᵀb for the 8 unknowns.
  const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const Atb = new Array(8).fill(0);
  const add = (row: number[], rhs: number) => {
    for (let i = 0; i < 8; i++) {
      if (row[i] === 0) continue;
      Atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
    }
  };
  for (let i = 0; i < n; i++) {
    const x = (src[i].x - ns.cx) * ns.s;
    const y = (src[i].y - ns.cy) * ns.s;
    const u = (dst[i].x - nd.cx) * nd.s;
    const v = (dst[i].y - nd.cy) * nd.s;
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solve(AtA, Atb);
  if (!h) return null;
  const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  // Denormalise: H = Td⁻¹ · Hn · Ts
  const Ts = [ns.s, 0, -ns.s * ns.cx, 0, ns.s, -ns.s * ns.cy, 0, 0, 1];
  const TdInv = [1 / nd.s, 0, nd.cx, 0, 1 / nd.s, nd.cy, 0, 0, 1];
  const H = mul(TdInv, mul(Hn, Ts));
  if (Math.abs(H[8]) < 1e-12) return null;
  return H.map((v) => v / H[8]);
}

export function mul(A: H3, B: H3): H3 {
  const C = new Array(9).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++)
      for (let k = 0; k < 3; k++) C[r * 3 + c] += A[r * 3 + k] * B[k * 3 + c];
  return C;
}

export function apply(H: H3, p: Pt): Pt {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}

/** Diagonal scaling matrix. */
export const scale = (sx: number, sy = sx): H3 => [sx, 0, 0, 0, sy, 0, 0, 0, 1];

/** Small deterministic PRNG so results are reproducible. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export type RansacResult = { H: H3; inliers: number[]; rmse: number };

/**
 * RANSAC homography. `threshold` is the reprojection error (px) for an inlier.
 * Refits on all inliers at the end.
 */
export function ransacHomography(
  src: Pt[],
  dst: Pt[],
  opts: { threshold?: number; iterations?: number; seed?: number } = {}
): RansacResult | null {
  const n = src.length;
  if (n < 4) return null;
  const thr2 = (opts.threshold ?? 3) ** 2;
  const iters = opts.iterations ?? 1500;
  const rand = rng(opts.seed ?? 12345);

  const countInliers = (H: H3) => {
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const q = apply(H, src[i]);
      const dx = q.x - dst[i].x;
      const dy = q.y - dst[i].y;
      if (dx * dx + dy * dy <= thr2) idx.push(i);
    }
    return idx;
  };

  let best: number[] = [];
  for (let it = 0; it < iters; it++) {
    const pick = new Set<number>();
    while (pick.size < 4) pick.add(Math.floor(rand() * n));
    const ids = [...pick];
    const H = fitHomography(
      ids.map((i) => src[i]),
      ids.map((i) => dst[i])
    );
    if (!H || !plausible(H)) continue;
    const inl = countInliers(H);
    if (inl.length > best.length) {
      best = inl;
      if (best.length > 0.9 * n) break;
    }
  }
  if (best.length < 4) return null;

  // Refine on inliers (twice, re-collecting inliers in between).
  let H = fitHomography(
    best.map((i) => src[i]),
    best.map((i) => dst[i])
  );
  if (!H) return null;
  const again = countInliers(H);
  if (again.length >= best.length) {
    best = again;
    H = fitHomography(
      best.map((i) => src[i]),
      best.map((i) => dst[i])
    ) ?? H;
  }
  let se = 0;
  for (const i of best) {
    const q = apply(H, src[i]);
    se += (q.x - dst[i].x) ** 2 + (q.y - dst[i].y) ** 2;
  }
  return { H, inliers: best, rmse: Math.sqrt(se / best.length) };
}

/**
 * Reject degenerate / wild homographies: repeat photos from (roughly) the same spot should
 * be close to a similarity transform — modest scale, no flip, little perspective.
 */
export function plausible(H: H3, maxScale = 2.5, maxPersp = 0.004): boolean {
  const det = H[0] * H[4] - H[1] * H[3];
  if (!(det > 1 / (maxScale * maxScale) && det < maxScale * maxScale)) return false;
  return Math.abs(H[6]) < maxPersp && Math.abs(H[7]) < maxPersp;
}
