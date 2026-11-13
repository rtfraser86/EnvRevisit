import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MARKER_COLOURS, MAX_MARKERS, MarkerOverlay } from '@/components/markers';
import { Btn, fmtDate, useColors } from '@/components/ui';
import { getCapture, parseMarkers, setMarkers, type Capture, type MarkerPt } from '@/lib/db';

/** Tap a marker within this fraction of the photo's width to remove it. */
const HIT = 0.035;

export default function MarkersScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const cid = Number(id);
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [cap, setCap] = useState<Capture | null>(null);
  const [pts, setPts] = useState<MarkerPt[]>([]);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    getCapture(cid).then((x) => {
      setCap(x);
      setPts(parseMarkers(x));
    });
  }, [cid]);

  const aspect = cap?.width && cap?.height ? cap.width / cap.height : 3 / 4;
  const w = box.w && box.h ? Math.min(box.w, box.h * aspect) : 0;
  const h = w / aspect;

  // Saved as you go, so the back button never loses work.
  const change = (next: MarkerPt[]) => {
    setPts(next);
    setMarkers(cid, next).catch((e) => console.warn('save markers', e));
  };

  const onTap = (x: number, y: number) => {
    if (!w) return;
    const fx = Math.max(0, Math.min(1, x / w));
    const fy = Math.max(0, Math.min(1, y / h));
    // Tapping an existing marker removes it.
    const hit = pts.findIndex((m) => Math.hypot((m.x - fx) * w, (m.y - fy) * h) < HIT * w);
    if (hit >= 0) {
      Haptics.selectionAsync();
      change(pts.filter((_m, i) => i !== hit));
      return;
    }
    if (pts.length >= MAX_MARKERS) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    change([...pts, { x: fx, y: fy }]);
  };

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <Stack.Screen options={{ title: cap ? `Markers · ${fmtDate(cap.taken_at)}` : 'Markers' }} />
      <View style={{ flex: 1 }} onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
        {cap && w > 0 && (
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center' }}
            maximumZoomScale={6}
            minimumZoomScale={1}
            bouncesZoom
            centerContent
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}>
            <Pressable
              style={{ width: w, height: h }}
              onPress={(e) => onTap(e.nativeEvent.locationX, e.nativeEvent.locationY)}>
              <Image source={{ uri: cap.uri }} style={StyleSheet.absoluteFill} contentFit="cover" pointerEvents="none" />
              <MarkerOverlay markers={pts} width={w} height={h} size={26} />
            </Pressable>
          </ScrollView>
        )}
      </View>

      <View style={[styles.panel, { backgroundColor: c.card, paddingBottom: Math.max(insets.bottom, 14) }]}>
        <Text style={{ color: c.text, fontWeight: '700', fontSize: 16 }}>
          {pts.length} of {MAX_MARKERS} markers
        </Text>
        <Text style={{ color: c.muted, fontSize: 13 }}>
          Tap fixed features that won&apos;t change between visits: a rock, a fence post, a notch on the skyline, a
          building corner. Spread them across the frame. Pinch to zoom for precision. Tap a marker to remove it.
        </Text>
        <View style={{ flexDirection: 'row', gap: 6 }}>
          {pts.map((_m, i) => (
            <View key={i} style={[styles.chip, { backgroundColor: MARKER_COLOURS[i % MARKER_COLOURS.length] }]}>
              <Text style={{ fontWeight: '900', fontSize: 12 }}>{i + 1}</Text>
            </View>
          ))}
        </View>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Btn title="Undo" kind="secondary" small disabled={!pts.length} onPress={() => change(pts.slice(0, -1))} style={{ flex: 1 }} />
          <Btn title="Clear" kind="secondary" small disabled={!pts.length} onPress={() => change([])} style={{ flex: 1 }} />
          <Btn title="Done" small onPress={() => router.back()} style={{ flex: 1.4 }} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { padding: 14, gap: 10, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  chip: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
