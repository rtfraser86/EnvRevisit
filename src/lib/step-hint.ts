/**
 * "Step left 0.4 m / forward 1 m" from near/far parallax.
 *
 * Turning the phone shifts the whole picture by the same angle. Stepping sideways by b shifts a
 * thing at distance Z by b / Z radians, so nearby ground moves much more than distant background.
 * The native side measures the shift of a near band (bottom of the frame) and a far band (top),
 * after removing the frame's rotation; the difference is the step, free of any turn.
 *
 * Distances come from the camera's tilt and an assumed phone height above the ground: a row of the
 * picture that looks d° below the horizon sees ground at h / tan(d). Rows at or above the horizon
 * count as far away. So the estimate needs ground (or something at a similar distance) in the
 * lower part of the view, and it scales with the height assumption: hold the phone at chest height.
 */

export type Bands = {
  farY: number; // band centres, fraction of the height from the top
  nearY: number;
  /** Shift to apply to the live frame so the band lines up with the ghost: fraction of width / height (x right, y down). */
  farDx?: number;
  farDy?: number;
  nearDx?: number;
  nearDy?: number;
};

export type StepHint = {
  /** Metres to step right (negative: left). */
  right: number;
  /** Metres to step forward (negative: back). */
  forward: number;
  /** Estimated distance to the ground in the near band, metres. */
  near: number;
};

const DEG = Math.PI / 180;
export const PHONE_HEIGHT_M = 1.5;

/** Horizontal distance to the ground seen at a row of the picture, or null at/above the horizon. */
export function groundDistance(rowFrac: number, pitchDeg: number, vfovDeg: number, height = PHONE_HEIGHT_M): number | null {
  const below = -pitchDeg + Math.atan((rowFrac - 0.5) * 2 * Math.tan((vfovDeg * DEG) / 2)) / DEG;
  if (below < 3) return null;
  return height / Math.tan(below * DEG);
}

export function stepHint(
  b: Bands | null | undefined,
  pitchDeg: number | null,
  hfovDeg: number,
  vfovDeg: number,
  height = PHONE_HEIGHT_M
): StepHint | null {
  if (!b || pitchDeg == null) return null;
  const { nearDx, nearDy, farDx, farDy } = b;
  if (nearDx == null || nearDy == null || farDx == null || farDy == null) return null;
  const zn = groundDistance(b.nearY, pitchDeg, vfovDeg, height);
  if (zn == null || zn > 40) return null; // looking at the horizon or above: no near ground to use
  const zf = groundDistance(b.farY, pitchDeg, vfovDeg, height);
  const invN = 1 / zn;
  const invF = zf == null ? 0 : 1 / zf;
  if (invN - invF < 0.02) return null; // both bands about as far away: no parallax to measure
  const kx = 2 * Math.tan((hfovDeg * DEG) / 2); // width fraction → radians (small angles)
  const ky = 2 * Math.tan((vfovDeg * DEG) / 2);
  // Standing b to the right of the original moves near things left by b / Z more than far things,
  // so the frame has to be shifted right (positive dx) to line up: positive means step left.
  const offsetRight = ((nearDx - farDx) * kx) / (invN - invF);
  // Ground at distance Z drops by h / (Z² + h²) radians per metre stepped forward. Standing too far
  // back puts near ground too high in the frame, so it has to move down (positive dy): step forward.
  const gN = height / (zn * zn + height * height);
  const gF = zf == null ? 0 : height / (zf * zf + height * height);
  if (gN - gF < 0.002) return null;
  const forward = ((nearDy - farDy) * ky) / (gN - gF);
  if (!isFinite(offsetRight) || !isFinite(forward)) return null;
  return { right: -offsetRight, forward, near: zn };
}

/** Exponential smoothing; a reading far from the last one restarts it. */
export function smoothStep(prev: StepHint | null, next: StepHint | null, k = 0.35): StepHint | null {
  if (!next) return prev;
  if (!prev) return next;
  const jump = Math.hypot(next.right - prev.right, next.forward - prev.forward);
  if (jump > 3) return next;
  const mix = (a: number, c: number) => a + k * (c - a);
  return { right: mix(prev.right, next.right), forward: mix(prev.forward, next.forward), near: next.near };
}

/** Text for the hint band, or null when there is nothing worth saying. */
export function stepText(s: StepHint | null): { text: string; ok: boolean } | null {
  if (!s) return null;
  const fmt = (m: number) => (Math.abs(m) >= 5 ? '5+ m' : Math.abs(m) >= 1 ? `${Math.abs(m).toFixed(1)} m` : `${Math.round(Math.abs(m) * 100)} cm`);
  const parts: string[] = [];
  if (Math.abs(s.right) >= 0.15) parts.push(`${s.right < 0 ? '← left' : 'right →'} ${fmt(s.right)}`);
  if (Math.abs(s.forward) >= 0.25) parts.push(`${s.forward > 0 ? '↑ forward' : '↓ back'} ${fmt(s.forward)}`);
  if (!parts.length) return { text: 'On the spot', ok: true };
  return { text: `Step ${parts.join(' · ')}`, ok: false };
}
