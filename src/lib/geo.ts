/** Small geodesy + angle helpers. All angles in degrees unless noted. */

const R_EARTH = 6371008.8; // mean Earth radius, metres
const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;

export type LatLon = { latitude: number; longitude: number };

/** Great-circle distance in metres (haversine). */
export function distanceM(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing from a to b, degrees clockwise from true north (0–360). */
export function bearingDeg(a: LatLon, b: LatLon): number {
  const φ1 = toRad(a.latitude);
  const φ2 = toRad(b.latitude);
  const Δλ = toRad(b.longitude - a.longitude);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return norm360(toDeg(Math.atan2(y, x)));
}

/** Normalise to [0, 360). */
export function norm360(d: number): number {
  return ((d % 360) + 360) % 360;
}

/** Signed smallest difference target − current, in (−180, 180]. Positive = turn right. */
export function angleDiff(target: number, current: number): number {
  let d = norm360(target) - norm360(current);
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * Offset of b from a expressed in the local frame of someone at a facing `facingDeg`.
 * Returns metres forward (+) / back (−) and right (+) / left (−).
 */
export function localOffset(a: LatLon, b: LatLon, facingDeg: number) {
  const d = distanceM(a, b);
  const rel = toRad(angleDiff(bearingDeg(a, b), facingDeg));
  return { forward: d * Math.cos(rel), right: d * Math.sin(rel), distance: d };
}

export function formatDistance(m: number): string {
  if (m < 1) return `${Math.round(m * 100)} cm`;
  if (m < 1000) return `${m < 10 ? m.toFixed(1) : Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 2 : 1)} km`;
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function compassPoint(deg: number): string {
  return COMPASS[Math.round(norm360(deg) / 45) % 8];
}

/** Rough bounding box for "photos within r metres of here" queries. */
export function bbox(center: LatLon, radiusM: number) {
  const dLat = toDeg(radiusM / R_EARTH);
  const dLon = toDeg(radiusM / (R_EARTH * Math.cos(toRad(center.latitude))));
  return {
    minLat: center.latitude - dLat,
    maxLat: center.latitude + dLat,
    minLon: center.longitude - dLon,
    maxLon: center.longitude + dLon,
  };
}
