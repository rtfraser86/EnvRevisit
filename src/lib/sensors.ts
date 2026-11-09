import * as Location from 'expo-location';
import { DeviceMotion } from 'expo-sensors';
import { useEffect, useRef, useState } from 'react';

import { norm360 } from './geo';

export type Attitude = {
  heading: number | null; // camera bearing, degrees true (falls back to magnetic)
  headingAccuracy: number | null;
  pitch: number | null; // camera elevation above horizon, degrees
  roll: number | null; // horizon tilt, degrees, + = phone rotated clockwise
};

/**
 * Camera pitch / roll from DeviceMotion's W3C-style Euler angles (radians).
 *
 * With R = Rz(α)·Rx(β)·Ry(γ) mapping device → earth (z up), the bottom row of R is
 * [−cosβ·sinγ, sinβ, cosβ·cosγ]. The back camera looks along device −z, so its
 * elevation is asin(−cosβ·cosγ). Horizon tilt is the angle of device +x out of the
 * horizontal plane, measured against device +y: atan2(cosβ·sinγ, sinβ).
 * Upright portrait phone → pitch 0, roll 0.
 */
export function pitchRollFromRotation(beta: number, gamma: number) {
  const cb = Math.cos(beta);
  const sb = Math.sin(beta);
  const cg = Math.cos(gamma);
  const sg = Math.sin(gamma);
  const pitch = (Math.asin(Math.max(-1, Math.min(1, -cb * cg))) * 180) / Math.PI;
  const roll = (Math.atan2(cb * sg, sb) * 180) / Math.PI;
  return { pitch, roll };
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
  });
  const headingRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let headingSub: Location.LocationSubscription | null = null;
    let cancelled = false;

    DeviceMotion.setUpdateInterval(intervalMs);
    const motionSub = DeviceMotion.addListener((m) => {
      if (!m.rotation) return;
      const { pitch, roll } = pitchRollFromRotation(m.rotation.beta, m.rotation.gamma);
      setAtt((a) => ({
        ...a,
        pitch: a.pitch === null ? pitch : a.pitch + 0.35 * (pitch - a.pitch),
        roll: a.roll === null ? roll : a.roll + 0.35 * (roll - a.roll),
      }));
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
