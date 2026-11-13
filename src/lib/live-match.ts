/**
 * Turn an image-registration result (live camera frame → ghost photo) into guidance.
 *
 * `h` maps live-frame pixels to ghost pixels, CoreImage coordinates (origin bottom-left, y up),
 * row-major. Sign conventions match the sensor guidance:
 *   turn  > 0 → turn right      tilt > 0 → tilt up
 *   rotate > 0 → rotate the phone clockwise
 *   scale > 1 → move closer (things look smaller than in the ghost)
 */
export type ImageGuidance = {
  turn: number; // degrees
  tilt: number; // degrees
  rotate: number; // degrees
  scale: number; // ratio
  /** 0–100: how much warping the live frame towards the ghost improved the match. */
  quality: number;
  /** Horizontal / vertical offset of the ghost centre in the live view, as a fraction of the frame (screen coords, y down). */
  ringX: number;
  ringY: number;
};

export function guidanceFromHomography(
  h: number[],
  width: number,
  height: number,
  hfov: number,
  vfov: number,
  diffBefore: number,
  diffAfter: number
): ImageGuidance | null {
  if (h.length !== 9 || !h.every(Number.isFinite)) return null;
  const cx = width / 2;
  const cy = height / 2;
  const w = h[6] * cx + h[7] * cy + h[8];
  if (Math.abs(w) < 1e-9) return null;
  const px = (h[0] * cx + h[1] * cy + h[2]) / w;
  const py = (h[3] * cx + h[4] * cy + h[5]) / w;
  const dx = (px - cx) / width; // live centre lands right of ghost centre → camera points too far right
  const dy = (py - cy) / height; // y up: live centre lands above ghost centre → camera points too high

  const det = h[0] * h[4] - h[1] * h[3];
  if (!(det > 0)) return null; // mirror image / degenerate
  const scale = Math.sqrt(det);
  // Content has to be rotated by +angle (counter-clockwise) to match → phone is rolled
  // counter-clockwise → rotate the phone clockwise.
  const angle = (Math.atan2(h[3], h[0]) * 180) / Math.PI;

  const quality = diffBefore > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - diffAfter / diffBefore)))) : 0;

  return {
    turn: -dx * hfov,
    tilt: -dy * vfov,
    rotate: angle,
    scale,
    quality,
    ringX: -dx,
    ringY: dy,
  };
}

/** Plausible for a repeat photo taken from about the same spot. */
export function plausibleGuidance(g: ImageGuidance) {
  return Math.abs(g.turn) < 35 && Math.abs(g.tilt) < 35 && Math.abs(g.rotate) < 25 && g.scale > 0.5 && g.scale < 2;
}
