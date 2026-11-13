import { StyleSheet, Text, View } from 'react-native';

import { angleDiff } from '@/lib/geo';
import type { ImageGuidance } from '@/lib/live-match';
import type { Attitude } from '@/lib/sensors';

/**
 * Field of view for a 4:3 frame from the lens's 35 mm-equivalent focal length
 * (26 mm = iPhone main camera → about 67° × 53°).
 */
export function fovFor(landscape: boolean, f35 = 26) {
  const deg = (side: number) => (2 * Math.atan(side / (2 * f35)) * 180) / Math.PI;
  const long = deg(34.6);
  const short = deg(25.96);
  return landscape ? { hfov: long, vfov: short } : { hfov: short, vfov: long };
}

export type Target = { heading: number | null; pitch: number | null; roll: number | null };

/**
 * What to do to line up with the ghost. Positive turn = turn right, tilt = tilt up,
 * rotate = rotate the phone clockwise, scale > 1 = move closer.
 */
export type Deltas = {
  source: 'image' | 'sensors';
  turn: number | null;
  tilt: number | null;
  rotate: number | null;
  scale: number | null;
  quality?: number;
  /** Where the ghost's centre is in the live view (fraction of frame, screen coords). */
  ringX: number | null;
  ringY: number | null;
};

const TOL = {
  sensors: { turn: 3, tilt: 2, rotate: 1.5, scale: 1 },
  image: { turn: 1, tilt: 1, rotate: 0.7, scale: 0.03 },
};

export function sensorDeltas(att: Attitude, target: Target, landscape: boolean, f35 = 26): Deltas {
  const { hfov, vfov } = fovFor(landscape, f35);
  const turn = target.heading != null && att.heading != null ? angleDiff(target.heading, att.heading) : null;
  const tilt = target.pitch != null && att.pitch != null ? target.pitch - att.pitch : null;
  const rotate = target.roll != null && att.roll != null ? target.roll - att.roll : null;
  return {
    source: 'sensors',
    turn,
    tilt,
    rotate,
    scale: null,
    ringX: turn != null ? Math.max(-0.5, Math.min(0.5, turn / hfov)) : null,
    ringY: tilt != null ? Math.max(-0.5, Math.min(0.5, -tilt / vfov)) : null,
  };
}

export function imageDeltas(g: ImageGuidance): Deltas {
  return {
    source: 'image',
    turn: g.turn,
    tilt: g.tilt,
    rotate: g.rotate,
    scale: g.scale,
    quality: g.quality,
    ringX: Math.max(-0.5, Math.min(0.5, g.ringX)),
    ringY: Math.max(-0.5, Math.min(0.5, g.ringY)),
  };
}

type Cell = { key: string; label: string; ok: boolean | null; text: string };

export function deltaCells(d: Deltas): Cell[] {
  const t = TOL[d.source];
  const ang = (v: number | null, tol: number, pos: string, neg: string, label: string): Cell =>
    v == null
      ? { key: label, label, ok: null, text: '—' }
      : Math.abs(v) <= tol
        ? { key: label, label, ok: true, text: '✓' }
        : { key: label, label, ok: false, text: `${v > 0 ? pos : neg} ${Math.abs(v).toFixed(1)}°` };
  const cells = [
    ang(d.turn, t.turn, '→', '←', 'Turn'),
    ang(d.tilt, t.tilt, '↑', '↓', 'Tilt'),
    ang(d.rotate, t.rotate, '↻', '↺', 'Rotate'),
  ];
  if (d.source === 'image' && d.scale != null) {
    const pct = (d.scale - 1) * 100;
    cells.push(
      Math.abs(d.scale - 1) <= t.scale
        ? { key: 'Dist', label: 'Distance', ok: true, text: '✓' }
        : { key: 'Dist', label: 'Distance', ok: false, text: pct > 0 ? `Closer ${pct.toFixed(0)}%` : `Back ${(-pct).toFixed(0)}%` }
    );
  }
  return cells;
}

export function allAligned(d: Deltas) {
  const cells = deltaCells(d);
  return cells.some((c) => c.ok !== null) && cells.every((c) => c.ok !== false);
}

/** Big, solid-coloured guidance band along the top of the frame. */
export function GuideHud({ d, video = false }: { d: Deltas; video?: boolean }) {
  const cells = deltaCells(d);
  return (
    <View style={styles.hud} pointerEvents="none">
      <View style={styles.cells}>
        {cells.map((c) => (
          <View
            key={c.key}
            style={[
              styles.cell,
              { backgroundColor: c.ok === null ? 'rgba(55,65,81,0.92)' : c.ok ? 'rgba(21,128,61,0.95)' : 'rgba(180,83,9,0.95)' },
            ]}>
            <Text style={styles.cellLabel}>{c.label}</Text>
            <Text style={styles.cellText} numberOfLines={1} adjustsFontSizeToFit>
              {c.text}
            </Text>
          </View>
        ))}
      </View>
      <Text style={styles.source}>
        {d.source === 'image' ? `📷 Image match${video ? ' (video)' : ''} · ${d.quality ?? 0}%` : '🧭 Compass & tilt sensors'}
      </Text>
    </View>
  );
}

/** Crosshair (fixed) and target ring (where the ghost's centre is) plus a horizon bar for roll. */
export function AlignmentGuide({ width, height, d }: { width: number; height: number; d: Deltas }) {
  const ok = allAligned(d);
  const ring = ok ? '#22C55E' : '#FACC15';
  const rollOk = d.rotate == null || Math.abs(d.rotate) <= TOL[d.source].rotate;
  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
      {/* crosshair with dark outline so it shows on any background */}
      <View style={styles.outlineH} />
      <View style={styles.outlineV} />
      <View style={styles.crossH} />
      <View style={styles.crossV} />

      {d.ringX != null && d.ringY != null && (
        <View
          style={[
            styles.ring,
            { borderColor: ring, transform: [{ translateX: d.ringX * width }, { translateY: d.ringY * height }] },
          ]}
        />
      )}
      {d.rotate != null && (
        <View
          style={[
            styles.horizon,
            { width: width * 0.7, backgroundColor: rollOk ? '#22C55E' : '#FACC15', transform: [{ rotate: `${d.rotate}deg` }] },
          ]}
        />
      )}
      {ok && (
        <View style={styles.okBanner}>
          <Text style={styles.okText}>✓ Lined up — take the photo</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  hud: { position: 'absolute', top: 0, left: 0, right: 0, padding: 6, gap: 4, backgroundColor: 'rgba(0,0,0,0.55)' },
  cells: { flexDirection: 'row', gap: 6 },
  cell: { flex: 1, borderRadius: 8, paddingVertical: 4, paddingHorizontal: 4, alignItems: 'center' },
  cellLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 11, fontWeight: '700', textTransform: 'uppercase' },
  cellText: { color: '#fff', fontSize: 20, fontWeight: '900', fontVariant: ['tabular-nums'] },
  source: { color: '#fff', fontSize: 12, fontWeight: '600', textAlign: 'center' },
  crossH: { position: 'absolute', width: 40, height: 3, backgroundColor: '#fff' },
  crossV: { position: 'absolute', width: 3, height: 40, backgroundColor: '#fff' },
  outlineH: { position: 'absolute', width: 44, height: 7, backgroundColor: 'rgba(0,0,0,0.6)' },
  outlineV: { position: 'absolute', width: 7, height: 44, backgroundColor: 'rgba(0,0,0,0.6)' },
  ring: { position: 'absolute', width: 64, height: 64, borderRadius: 32, borderWidth: 5 },
  horizon: { position: 'absolute', height: 3, opacity: 0.95 },
  okBanner: {
    position: 'absolute',
    bottom: '22%',
    backgroundColor: 'rgba(21,128,61,0.95)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
  },
  okText: { color: '#fff', fontWeight: '900', fontSize: 17 },
});
