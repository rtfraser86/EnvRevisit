import { StyleSheet, Text, View } from 'react-native';

import { angleDiff, bearingDeg, distanceM, formatDistance, localOffset, type LatLon } from '@/lib/geo';
import type { Fix } from '@/lib/sensors';

/** A proper arrow (shaft + head), pointing up before rotation. */
export function Arrow({ size = 48, color = '#fff', rotate = 0 }: { size?: number; color?: string; rotate?: number }) {
  const head = size * 0.42;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', transform: [{ rotate: `${rotate}deg` }] }}>
      <View
        style={{
          width: 0,
          height: 0,
          borderLeftWidth: head * 0.75,
          borderRightWidth: head * 0.75,
          borderBottomWidth: head,
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
          borderBottomColor: color,
        }}
      />
      <View style={{ width: size * 0.2, height: size - head, backgroundColor: color, borderRadius: 2 }} />
    </View>
  );
}

/** "Arrived" radius: the GPS error circle, but never tighter than 3 m or looser than 15 m. */
export const arriveRadius = (fix: Fix | null) => Math.max(3, Math.min(fix?.accuracy ?? 8, 15));

const fmtOff = (m: number, pos: string, neg: string) =>
  `${formatDistance(Math.abs(m))} ${m >= 0 ? pos : neg}`;

/**
 * Stake-out readout for the camera screen: an arrow relative to where the camera faces,
 * distance, and the offset split into ahead/behind and left/right.
 * Rendered inside the camera's physical frame, so "up" is straight ahead.
 */
export function StakeoutChip({
  fix,
  target,
  heading,
}: {
  fix: Fix | null;
  target: LatLon | null;
  heading: number | null;
}) {
  if (!target) return null;
  if (!fix) {
    return (
      <View style={styles.chip}>
        <Text style={styles.sub}>Waiting for GPS…</Text>
      </View>
    );
  }
  const d = distanceM(fix, target);
  const r = arriveRadius(fix);
  const at = d <= r;
  const rel = heading != null ? angleDiff(bearingDeg(fix, target), heading) : null;
  const off = heading != null ? localOffset(fix, target, heading) : null;
  const color = at ? '#4ADE80' : '#FACC15';

  return (
    <View style={styles.chip}>
      {at ? (
        <View style={[styles.dot, { borderColor: color }]} />
      ) : (
        <Arrow size={34} color={color} rotate={rel ?? 0} />
      )}
      <View style={{ flexShrink: 1 }}>
        <Text style={[styles.dist, { color }]}>
          {formatDistance(d)}
          <Text style={styles.acc}>{fix.accuracy != null ? `  ±${fix.accuracy.toFixed(0)} m` : ''}</Text>
        </Text>
        <Text style={styles.sub}>
          {at
            ? 'On the point (within GPS) — fine-tune with the ghost'
            : off
              ? `${fmtOff(off.forward, 'ahead', 'behind')} · ${fmtOff(off.right, 'right', 'left')}`
              : 'Compass not ready'}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    position: 'absolute',
    left: 10,
    bottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    maxWidth: '92%',
  },
  dot: { width: 26, height: 26, borderRadius: 13, borderWidth: 4, margin: 4 },
  dist: { fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] },
  acc: { fontSize: 12, fontWeight: '600', color: 'rgba(255,255,255,0.75)' },
  sub: { color: '#fff', fontSize: 12, fontWeight: '600' },
});
