import { StyleSheet, Text, View } from 'react-native';

import { angleDiff } from '@/lib/geo';
import type { Attitude } from '@/lib/sensors';

// Approximate field of view of the iPhone main (1×) camera in a portrait 3:4 frame.
const HFOV = 50;
const VFOV = 64;

export const TOL = { heading: 3, pitch: 2, roll: 1.5 };

export type Target = { heading: number | null; pitch: number | null; roll: number | null };

export function attitudeDeltas(att: Attitude, target: Target) {
  return {
    dHeading: target.heading != null && att.heading != null ? angleDiff(target.heading, att.heading) : null,
    dPitch: target.pitch != null && att.pitch != null ? target.pitch - att.pitch : null,
    dRoll: target.roll != null && att.roll != null ? target.roll - att.roll : null,
  };
}

/**
 * Overlay drawn on the camera box: a target ring sits where the centre of the reference
 * view is, relative to where the camera points now. Move the phone until the ring
 * covers the centre cross. The horizon bar shows how far to rotate to match the roll.
 */
export function AlignmentGuide({
  width,
  height,
  att,
  target,
}: {
  width: number;
  height: number;
  att: Attitude;
  target: Target;
}) {
  const { dHeading, dPitch, dRoll } = attitudeDeltas(att, target);
  const hasAny = dHeading != null || dPitch != null;
  const dx = dHeading != null ? Math.max(-1, Math.min(1, dHeading / HFOV)) * width : 0;
  const dy = dPitch != null ? Math.max(-1, Math.min(1, -dPitch / VFOV)) * height : 0;
  const okH = dHeading == null || Math.abs(dHeading) <= TOL.heading;
  const okP = dPitch == null || Math.abs(dPitch) <= TOL.pitch;
  const okR = dRoll == null || Math.abs(dRoll) <= TOL.roll;
  const allOk = okH && okP && okR && (dHeading != null || dPitch != null || dRoll != null);
  const ring = allOk ? '#4ADE80' : '#FACC15';

  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
      {/* fixed centre cross */}
      <View style={[styles.crossH, { backgroundColor: 'rgba(255,255,255,0.85)' }]} />
      <View style={[styles.crossV, { backgroundColor: 'rgba(255,255,255,0.85)' }]} />

      {/* where the reference centre is */}
      {hasAny && (
        <View
          style={[
            styles.ring,
            { borderColor: ring, transform: [{ translateX: dx }, { translateY: dy }] },
          ]}
        />
      )}

      {/* roll: a horizon bar tilted by the roll error */}
      {dRoll != null && (
        <View
          style={[
            styles.horizon,
            { width: width * 0.6, backgroundColor: okR ? '#4ADE80' : '#FACC15', transform: [{ rotate: `${dRoll}deg` }] },
          ]}
        />
      )}
    </View>
  );
}

export function GuideReadout({ att, target }: { att: Attitude; target: Target }) {
  const { dHeading, dPitch, dRoll } = attitudeDeltas(att, target);
  const item = (label: string, d: number | null, tol: number, pos: string, neg: string) => {
    if (d == null) return <Text style={[styles.read, { color: 'rgba(255,255,255,0.5)' }]}>{label} —</Text>;
    const ok = Math.abs(d) <= tol;
    return (
      <Text style={[styles.read, { color: ok ? '#4ADE80' : '#FACC15' }]}>
        {ok ? `${label} ✓` : `${d > 0 ? pos : neg} ${Math.abs(d).toFixed(1)}°`}
      </Text>
    );
  };
  return (
    <View style={styles.readRow}>
      {item('Heading', dHeading, TOL.heading, '↻ Turn right', '↺ Turn left')}
      {item('Pitch', dPitch, TOL.pitch, '↑ Tilt up', '↓ Tilt down')}
      {item('Level', dRoll, TOL.roll, '⟳ Rotate cw', '⟲ Rotate ccw')}
    </View>
  );
}

const styles = StyleSheet.create({
  crossH: { position: 'absolute', width: 28, height: 2 },
  crossV: { position: 'absolute', width: 2, height: 28 },
  ring: { position: 'absolute', width: 54, height: 54, borderRadius: 27, borderWidth: 3 },
  horizon: { position: 'absolute', height: 2, opacity: 0.9 },
  readRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 12, gap: 6 },
  read: { fontSize: 13, fontWeight: '700', flexShrink: 1 },
});
