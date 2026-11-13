import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MARKER_COLOURS, MAX_MARKERS, MarkerOverlay } from '@/components/markers';
import { Btn, fmtDate, useColors } from '@/components/ui';
import { alignByMarkers } from '@/lib/align';
import { getCapture, getReference, parseMarkers, setMarkers, type Capture, type MarkerPt } from '@/lib/db';

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
  const [ref, setRef] = useState<Capture | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    getCapture(cid).then(async (x) => {
      setCap(x);
      setPts(parseMarkers(x));
      if (x) setRef(await getReference(x.station_id));
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

  // A photo other than the reference: its markers are tie points that must match the
  // reference's markers one for one, so it can be aligned by hand.
  // (Only once the reference has markers; until then any photo can be marked freely.)
  const matching = !!cap && !!ref && ref.id !== cap.id && parseMarkers(ref).length >= 2;
  const refPts = matching ? parseMarkers(ref) : [];
  const limit = matching ? refPts.length : MAX_MARKERS;
  const refAspect = ref?.width && ref?.height ? ref.width / ref.height : 3 / 4;
  const refH = 110;
  const refW = refH * refAspect;

  const align = async () => {
    if (!cap) return;
    setWorking(true);
    try {
      await setMarkers(cid, pts);
      const res = await alignByMarkers(cap.station_id, cap.id);
      if (res.ok) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.back();
      } else Alert.alert("Couldn't align", res.reason);
    } catch (e) {
      Alert.alert("Couldn't align", String(e instanceof Error ? e.message : e));
    } finally {
      setWorking(false);
    }
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
    if (pts.length >= limit) {
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
        {matching ? (
          <View style={{ flexDirection: 'row', gap: 12 }}>
            {ref && (
              <View style={{ width: refW, height: refH, borderRadius: 8, overflow: 'hidden' }}>
                <Image source={{ uri: ref.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
                <MarkerOverlay markers={refPts} width={refW} height={refH} size={12} />
              </View>
            )}
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={{ color: c.text, fontWeight: '700', fontSize: 16 }}>
                {pts.length} of {refPts.length} matched
              </Text>
              <Text style={{ color: c.muted, fontSize: 13 }}>
                {refPts.length < 2
                  ? 'The reference photo needs markers first. Open the reference, add 4 or more, then come back.'
                  : pts.length < refPts.length
                    ? `Tap feature ${pts.length + 1} from the reference photo (shown left) on this photo. Keep the same order. Pinch to zoom.`
                    : 'All matched. Tap Align to warp this photo onto the reference using these points.'}
              </Text>
            </View>
          </View>
        ) : (
          <>
            <Text style={{ color: c.text, fontWeight: '700', fontSize: 16 }}>
              {pts.length} of {MAX_MARKERS} markers
            </Text>
            <Text style={{ color: c.muted, fontSize: 13 }}>
              Tap fixed features that won&apos;t change between visits: a rock, a fence post, a notch on the skyline, a
              building corner. Spread them across the frame; 4 or more also lets you align other photos by hand.
              Pinch to zoom. Tap a marker to remove it.
            </Text>
          </>
        )}
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
          {matching && refPts.length >= 2 ? (
            <Btn
              title={working ? 'Aligning…' : 'Align'}
              small
              disabled={working || pts.length !== refPts.length}
              onPress={align}
              style={{ flex: 1.4 }}
            />
          ) : (
            <Btn title="Done" small onPress={() => router.back()} style={{ flex: 1.4 }} />
          )}
        </View>
      </View>
      {working && (
        <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.4)' }]}>
          <ActivityIndicator color="#fff" size="large" />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { padding: 14, gap: 10, borderTopLeftRadius: 16, borderTopRightRadius: 16 },
  chip: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
