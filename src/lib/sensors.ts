import * as Location from 'expo-location';
import { DeviceMotion } from 'expo-sensors';
import { useEffect, useRef, useState } from 'react';

import { norm360 } from './geo';

/** How the phone is physically held. 'cw' = turned clockwise (top of phone to the right). */
export type HoldOrientation = 'portrait' | 'cw' | 'ccw';
export type ShotOrientation = 'portrait' | 'landscape';

export type Attitude = {
  heading: number | null; // camera bearing, degrees true (falls back to magnetic)
  headingAccuracy: number | null;
  pitch: number | null; // camera elevation above horizon, degrees
  /** Horizon tilt relative to how the phone is held (portrait or landscape), degrees, + = clockwise. */
  roll: number | null;
  /** Raw tilt of the phone's long axis from vertical: 0 portrait, +90 turned clockwise, −90 counter-clockwise. */
  rawRoll: number | null;
  hold: HoldOrientation;
};

/**
 * Camera pitch / roll straight from the gravity vector (device frame, any units).
 *
 * Device axes: +x right, +y top of phone, +z out of the screen. The back camera looks
 * along −z. Gravity g points down. Camera elevation = asin(g_z / |g|); tilt of the
 * phone's long axis about the camera axis = atan2(−g_x, −g_y).
 * Upright portrait → g = (0, −1, 0) → pitch 0, rawRoll 0. Top turned right → g = (−1, 0, 0) → rawRoll +90.
 */
export function pitchRollFromGravity(gx: number, gy: number, gz: number) {
  const n = Math.hypot(gx, gy, gz) || 1;
  const pitch = (Math.asin(Math.max(-1, Math.min(1, gz / n))) * 180) / Math.PI;
  const rawRoll = (Math.atan2(-gx, -gy) * 180) / Math.PI;
  return { pitch, rawRoll };
}

/** Which way the phone is held, with 10° hysteresis so it doesn't flicker at 45°. */
export function holdFromRawRoll(rawRoll: number, prev: HoldOrientation): HoldOrientation {
  const m = (lo: number) => (prev === 'portrait' ? lo + 10 : lo - 10);
  if (rawRoll > m(45) && rawRoll < 135) return 'cw';
  if (rawRoll < -m(45) && rawRoll > -135) return 'ccw';
  if (Math.abs(rawRoll) < (prev === 'portrait' ? 55 : 35)) return 'portrait';
  return prev;
}

export const shotOf = (h: HoldOrientation): ShotOrientation => (h === 'portrait' ? 'portrait' : 'landscape');

/** Horizon tilt relative to the frame the phone is held in. */
export function frameRoll(rawRoll: number, hold: HoldOrientation) {
  const r = hold === 'cw' ? rawRoll - 90 : hold === 'ccw' ? rawRoll + 90 : rawRoll;
  return r > 180 ? r - 360 : r < -180 ? r + 360 : r;
}

/** Signed difference next − prev in (−180, 180]. */
function angleStep(next: number, prev: number) {
  let d = next - prev;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Low-pass filter that handles the 359°→0° wrap. */
function smoothAngle(prev: number | null, next: number, k: number) {
  if (prev === null) return next;
  let d = next - prev;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return norm360(prev + k * d);
}

export function useAttitude(enabled = true, intervalMs = 60): Attitude {
  const [att, setAtt] = useState<Attitude>({
    heading: null,
    headingAccuracy: null,
    pitch: null,
    roll: null,
    rawRoll: null,
    hold: 'portrait',
  });
  const headingRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let headingSub: Location.LocationSubscription | null = null;
    let cancelled = false;

    DeviceMotion.setUpdateInterval(intervalMs);
    const motionSub = DeviceMotion.addListener((m) => {
      const g = m.accelerationIncludingGravity;
      const a = m.acceleration;
      if (!g) return;
      // Gravity alone = (user acceleration + gravity) − user acceleration.
      const gx = g.x - (a?.x ?? 0);
      const gy = g.y - (a?.y ?? 0);
      const gz = g.z - (a?.z ?? 0);
      const { pitch, rawRoll } = pitchRollFromGravity(gx, gy, gz);
      setAtt((s) => {
        const raw =
          s.rawRoll === null ? rawRoll : angleStep(s.rawRoll + 0.35 * angleStep(rawRoll, s.rawRoll), 0);
        const hold = holdFromRawRoll(raw, s.hold);
        return {
          ...s,
          pitch: s.pitch === null ? pitch : s.pitch + 0.35 * (pitch - s.pitch),
          rawRoll: raw,
          roll: frameRoll(raw, hold),
          hold,
        };
      });
    });

    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted' || cancelled) return;
      headingSub = await Location.watchHeadingAsync((h) => {
        const raw = h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
        headingRef.current = smoothAngle(headingRef.current, raw, 0.3);
        setAtt((a) => ({ ...a, heading: headingRef.current, headingAccuracy: h.accuracy }));
      });
      if (cancelled) headingSub.remove();
    })();

    return () => {
      cancelled = true;
      motionSub.remove();
      headingSub?.remove();
    };
  }, [enabled, intervalMs]);

  return att;
}

export type Fix = {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  altitude: number | null;
};

export function usePosition(enabled = true, highAccuracy = false) {
  const [fix, setFix] = useState<Fix | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setDenied(true);
        return;
      }
      if (cancelled) return;
      sub = await Location.watchPositionAsync(
        {
          accuracy: highAccuracy ? Location.Accuracy.BestForNavigation : Location.Accuracy.Balanced,
          distanceInterval: highAccuracy ? 0 : 10,
          timeInterval: highAccuracy ? 500 : 5000,
        },
        (l) =>
          setFix({
            latitude: l.coords.latitude,
            longitude: l.coords.longitude,
            accuracy: l.coords.accuracy,
            altitude: l.coords.altitude,
          })
      );
      if (cancelled) sub.remove();
    })();
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [enabled, highAccuracy]);

  return { fix, denied };
}
