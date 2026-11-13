import { StyleSheet, Text, View } from 'react-native';

import type { MarkerPt } from '@/lib/db';

export const MARKER_COLOURS = ['#22D3EE', '#F472B6', '#FACC15', '#A3E635', '#FB923C', '#C084FC', '#FFFFFF', '#F87171'];
export const MAX_MARKERS = 8;

/**
 * Alignment markers drawn over a photo or the camera view. Each one is a numbered ring with a
 * cross through a clear centre, so the feature underneath stays visible. Positions are
 * fractions of the frame, so they land on the same feature at any display size.
 */
export function MarkerOverlay({
  markers,
  width,
  height,
  size = 34,
}: {
  markers: MarkerPt[];
  width: number;
  height: number;
  size?: number;
}) {
  if (!markers.length) return null;
  const arm = size * 0.55;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {markers.map((m, i) => {
        const colour = MARKER_COLOURS[i % MARKER_COLOURS.length];
        const x = m.x * width;
        const y = m.y * height;
        const bar = { position: 'absolute' as const, backgroundColor: colour };
        return (
          <View key={i} style={{ position: 'absolute', left: x - size / 2, top: y - size / 2, width: size, height: size }}>
            <View style={[styles.ring, { borderColor: 'rgba(0,0,0,0.65)', borderWidth: 5, borderRadius: size / 2 }]} />
            <View style={[styles.ring, { borderColor: colour, borderWidth: 2.5, borderRadius: size / 2, margin: 1.25 }]} />
            {/* four arms that stop short of the centre */}
            <View style={[bar, { left: -arm, top: size / 2 - 1, width: arm, height: 2 }]} />
            <View style={[bar, { left: size, top: size / 2 - 1, width: arm, height: 2 }]} />
            <View style={[bar, { top: -arm, left: size / 2 - 1, height: arm, width: 2 }]} />
            <View style={[bar, { top: size, left: size / 2 - 1, height: arm, width: 2 }]} />
            <View style={[styles.dot, { left: size / 2 - 1.5, top: size / 2 - 1.5, backgroundColor: colour }]} />
            <Text style={[styles.num, { left: size + 2, top: -size * 0.45, color: colour }]}>{i + 1}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  ring: { ...StyleSheet.absoluteFill },
  dot: { position: 'absolute', width: 3, height: 3, borderRadius: 1.5 },
  num: {
    position: 'absolute',
    fontSize: 13,
    fontWeight: '900',
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowRadius: 3,
    textShadowOffset: { width: 0, height: 1 },
  },
});
