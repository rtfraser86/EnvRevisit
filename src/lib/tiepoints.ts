/**
 * Work out the transform that maps points marked on one photo onto the same features marked on
 * the reference. All matrices are row-major 3×3 arrays [a b c d e f g h 1]; points are pixels.
 *
 *   2 points → shift + rotate + scale (similarity)
 *   3 points → affine
 *   4+       → full perspective (homography), falling back to affine if the result is wild
 */
export type Pt = { x: number; y: number };
export type H3 = number[];

/** Solve A·x = b by Gaussian elimination with partial pivoting. Returns null if singular. */
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

/** Least squares via the normal equations: rows of [coefficients…] with right-hand sides. */
function leastSquares(rows: number[][], rhs: number[], unknowns: number): number[] | null {
  const AtA = Array.from({ length: unknowns }, () => new Array(unknowns).fill(0));
  const Atb = new Array(unknowns).fill(0);
  rows.forEach((row, r) => {
    for (let i = 0; i < unknowns; i++) {
      if (row[i] === 0) continue;
      Atb[i] += row[i] * rhs[r];
      for (let j = 0; j < unknowns; j++) AtA[i][j] += row[i] * row[j];
    }
  });
  return solve(AtA, Atb);
}

export function mul(A: H3, B: H3): H3 {
  const C = new Array(9).fill(0);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) C[r * 3 + c] += A[r * 3 + k] * B[k * 3 + c];
  return C;
}

export function apply(H: H3, p: Pt): Pt {
  const w = H[6] * p.x + H[7] * p.y + H[8];
  return { x: (H[0] * p.x + H[1] * p.y + H[2]) / w, y: (H[3] * p.x + H[4] * p.y + H[5]) / w };
}

/** Shift + rotate + uniform scale from 2 or more pairs (least squares). */
export function fitSimilarity(src: Pt[], dst: Pt[]): H3 | null {
  // x' = a·x − b·y + tx ;  y' = b·x + a·y + ty
  const rows: number[][] = [];
  const rhs: number[] = [];
  src.forEach((p, i) => {
    rows.push([p.x, -p.y, 1, 0]);
    rhs.push(dst[i].x);
    rows.push([p.y, p.x, 0, 1]);
    rhs.push(dst[i].y);
  });
  const s = leastSquares(rows, rhs, 4);
  if (!s) return null;
  const [a, b, tx, ty] = s;
  return [a, -b, tx, b, a, ty, 0, 0, 1];
}

/** Affine from 3 or more pairs (least squares). */
export function fitAffine(src: Pt[], dst: Pt[]): H3 | null {
  const rows = src.map((p) => [p.x, p.y, 1]);
  const ax = leastSquares(rows, dst.map((p) => p.x), 3);
  const ay = leastSquares(rows, dst.map((p) => p.y), 3);
  if (!ax || !ay) return null;
  return [ax[0], ax[1], ax[2], ay[0], ay[1], ay[2], 0, 0, 1];
}

/** Centre the points and scale them to a mean distance of √2, for numerical stability. */
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

/** Perspective transform from 4 or more pairs (least squares). */
export function fitHomography(src: Pt[], dst: Pt[]): H3 | null {
  if (src.length < 4) return null;
  const ns = normaliser(src);
  const nd = normaliser(dst);
  const rows: number[][] = [];
  const rhs: number[] = [];
  src.forEach((p, i) => {
    const x = (p.x - ns.cx) * ns.s;
    const y = (p.y - ns.cy) * ns.s;
    const u = (dst[i].x - nd.cx) * nd.s;
    const v = (dst[i].y - nd.cy) * nd.s;
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    rhs.push(u);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    rhs.push(v);
  });
  const h = leastSquares(rows, rhs, 8);
  if (!h) return null;
  const Hn = [...h, 1];
  const Ts = [ns.s, 0, -ns.s * ns.cx, 0, ns.s, -ns.s * ns.cy, 0, 0, 1];
  const TdInv = [1 / nd.s, 0, nd.cx, 0, 1 / nd.s, nd.cy, 0, 0, 1];
  const H = mul(TdInv, mul(Hn, Ts));
  if (Math.abs(H[8]) < 1e-12) return null;
  return H.map((v) => v / H[8]);
}

/** Reasonable for two photos of the same scene from about the same spot. */
export function plausible(H: H3, width: number, height: number): boolean {
  if (!H.every(Number.isFinite)) return false;
  const det = H[0] * H[4] - H[1] * H[3];
  if (!(det > 0.16 && det < 6.25)) return false; // scale between 0.4× and 2.5×, no mirror
  // Perspective terms must leave every corner well in front of the camera.
  for (const [x, y] of [[0, 0], [width, 0], [0, height], [width, height]]) {
    const w = H[6] * x + H[7] * y + H[8];
    if (!(w > 0.5 && w < 2)) return false;
  }
  return true;
}

export type TieFit = { H: H3; model: 'similarity' | 'affine' | 'perspective'; rms: number };

/** Best transform for the number of pairs available. width/height: size of the photo being moved. */
export function fitFromPairs(src: Pt[], dst: Pt[], width: number, height: number): TieFit | null {
  const n = Math.min(src.length, dst.length);
  if (n < 2) return null;
  const s = src.slice(0, n);
  const d = dst.slice(0, n);
  let H: H3 | null = null;
  let model: TieFit['model'] = 'similarity';
  if (n >= 4) {
    H = fitHomography(s, d);
    model = 'perspective';
    if (!H || !plausible(H, width, height)) H = null;
  }
  if (!H && n >= 3) {
    H = fitAffine(s, d);
    model = 'affine';
    if (!H || !plausible(H, width, height)) H = null;
  }
  if (!H) {
    H = fitSimilarity(s, d);
    model = 'similarity';
    if (!H || !plausible(H, width, height)) return null;
  }
  let se = 0;
  for (let i = 0; i < n; i++) {
    const q = apply(H, s[i]);
    se += (q.x - d[i].x) ** 2 + (q.y - d[i].y) ** 2;
  }
  return { H, model, rms: Math.sqrt(se / n) };
}
