import { StyleSheet, Text, View } from 'react-native';

import { angleDiff } from '@/lib/geo';
import type { Attitude } from '@/lib/sensors';

// Approximate field of view of the iPhone main (1×) camera, portrait 3:4 frame.
// Landscape swaps them.
const FOV_SHORT = 50;
const FOV_LONG = 64;

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
 * Overlay drawn in the *physical* frame (already rotated to match how the phone is held):
 * a target ring sits where the centre of the reference view is, relative to where the
 * camera points now. Move the phone until the ring covers the centre cross. The horizon
 * bar shows how far to rotate to match the roll.
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
  const landscape = width > height;
  const hfov = landscape ? FOV_LONG : FOV_SHORT;
  const vfov = landscape ? FOV_SHORT : FOV_LONG;
  const { dHeading, dPitch, dRoll } = attitudeDeltas(att, target);
  const hasAny = dHeading != null || dPitch != null;
  const dx = dHeading != null ? Math.max(-1, Math.min(1, dHeading / hfov)) * width : 0;
  const dy = dPitch != null ? Math.max(-1, Math.min(1, -dPitch / vfov)) * height : 0;
  const okH = dHeading == null || Math.abs(dHeading) <= TOL.heading;
  const okP = dPitch == null || Math.abs(dPitch) <= TOL.pitch;
  const okR = dRoll == null || Math.abs(dRoll) <= TOL.roll;
  const allOk = okH && okP && okR && (dHeading != null || dPitch != null || dRoll != null);
  const ring = allOk ? '#4ADE80' : '#FACC15';

  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
      <View style={[styles.crossH, { backgroundColor: 'rgba(255,255,255,0.85)' }]} />
      <View style={[styles.crossV, { backgroundColor: 'rgba(255,255,255,0.85)' }]} />

      {hasAny && (
        <View style={[styles.ring, { borderColor: ring, transform: [{ translateX: dx }, { translateY: dy }] }]} />
      )}

      {dRoll != null && (
        <View
          style={[
            styles.horizon,
            {
              width: width * 0.6,
              backgroundColor: okR ? '#4ADE80' : '#FACC15',
              transform: [{ rotate: `${dRoll}deg` }],
            },
          ]}
        />
      )}
    </View>
  );
}

/** Text readout, laid out to sit along the top edge of the physical frame. */
export function GuideReadout({ att, target }: { att: Attitude; target: Target }) {
  const { dHeading, dPitch, dRoll } = attitudeDeltas(att, target);
  const item = (label: string, d: number | null, tol: number, pos: string, neg: string) => {
    if (d == null) return <Text style={[styles.read, { color: 'rgba(255,255,255,0.55)' }]}>{label} —</Text>;
    const ok = Math.abs(d) <= tol;
    return (
      <Text style={[styles.read, { color: ok ? '#4ADE80' : '#FACC15' }]}>
        {ok ? `${label} ✓` : `${d > 0 ? pos : neg} ${Math.abs(d).toFixed(1)}°`}
      </Text>
    );
  };
  return (
    <View style={styles.readBand} pointerEvents="none">
      <View style={styles.readRow}>
        {item('Heading', dHeading, TOL.heading, '↻ Turn right', '↺ Turn left')}
        {item('Pitch', dPitch, TOL.pitch, '↑ Tilt up', '↓ Tilt down')}
        {item('Level', dRoll, TOL.roll, '⟳ Rotate cw', '⟲ Rotate ccw')}
      </View>
      <Text style={styles.raw}>
        hdg {att.heading != null ? `${att.heading.toFixed(0)}°` : '—'}
        {'   '}pitch {att.pitch != null ? `${att.pitch.toFixed(1)}°` : '—'}
        {'   '}roll {att.roll != null ? `${att.roll.toFixed(1)}°` : '—'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  crossH: { position: 'absolute', width: 28, height: 2 },
  crossV: { position: 'absolute', width: 2, height: 28 },
  ring: { position: 'absolute', width: 54, height: 54, borderRadius: 27, borderWidth: 3 },
  horizon: { position: 'absolute', height: 2, opacity: 0.9 },
  readBand: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingVertical: 6,
    backgroundColor: 'rgba(0,0,0,0.45)',
    gap: 2,
  },
  readRow: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 10, gap: 6 },
  read: { fontSize: 13, fontWeight: '700', flexShrink: 1 },
  raw: { color: 'rgba(255,255,255,0.7)', fontSize: 11, textAlign: 'center', fontVariant: ['tabular-nums'] },
});
