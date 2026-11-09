import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Circle, Marker, Polyline } from 'react-native-maps';

import { Arrow, arriveRadius } from '@/components/stakeout';
import { Btn, useColors } from '@/components/ui';
import { getReference, getStation, type Capture, type Station } from '@/lib/db';
import { angleDiff, bearingDeg, compassPoint, distanceM, formatDistance, localOffset, neOffset } from '@/lib/geo';
import { useAttitude, usePosition } from '@/lib/sensors';

const fmtOff = (m: number, pos: string, neg: string) => `${formatDistance(Math.abs(m))} ${m >= 0 ? pos : neg}`;

export default function Navigate() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const sid = Number(id);
  const c = useColors();
  const [station, setStation] = useState<Station | null>(null);
  const [ref, setRef] = useState<Capture | null>(null);
  const [follow, setFollow] = useState(true);
  const { fix, denied } = usePosition(true, true);
  const att = useAttitude(true, 100);
  const mapRef = useRef<MapView>(null);
  const arrivedRef = useRef(false);

  useEffect(() => {
    getStation(sid).then(setStation);
    getReference(sid).then(setRef);
  }, [sid]);

  const target = station ? { latitude: station.lat, longitude: station.lon } : null;
  const dist = fix && target ? distanceM(fix, target) : null;
  const brg = fix && target ? bearingDeg(fix, target) : null;
  const ne = fix && target ? neOffset(fix, target) : null;
  const turn = brg != null && att.heading != null ? angleDiff(brg, att.heading) : null;
  const local = fix && target && att.heading != null ? localOffset(fix, target, att.heading) : null;
  const arriveR = arriveRadius(fix);
  const arrived = dist != null && dist <= arriveR;

  useEffect(() => {
    if (arrived && !arrivedRef.current) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    arrivedRef.current = arrived;
  }, [arrived]);

  // Keep both you and the point in view, tightening as you close in (refit after moving a few metres).
  const lastFit = useRef<{ latitude: number; longitude: number } | null>(null);
  const tLat = station?.lat;
  const tLon = station?.lon;
  useEffect(() => {
    if (!follow || !fix || tLat == null || tLon == null) return;
    const step = Math.max(1, Math.min(8, distanceM(fix, { latitude: tLat, longitude: tLon }) / 10));
    if (lastFit.current && distanceM(lastFit.current, fix) < step) return;
    lastFit.current = { latitude: fix.latitude, longitude: fix.longitude };
    mapRef.current?.fitToCoordinates([fix, { latitude: tLat, longitude: tLon }], {
      edgePadding: { top: 120, right: 60, bottom: 60, left: 60 },
      animated: true,
    });
  }, [fix, tLat, tLon, follow]);

  const openMaps = () => {
    if (!target) return;
    const q = `${target.latitude},${target.longitude}`;
    Linking.openURL(Platform.OS === 'ios' ? `http://maps.apple.com/?daddr=${q}&dirflg=w` : `geo:${q}?q=${q}`);
  };

  const lineColor = arrived ? '#4ADE80' : '#FACC15';

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ title: station?.name ?? 'Navigate' }} />

      <View style={{ height: '52%' }}>
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          mapType="hybrid"
          showsUserLocation
          showsCompass={false}
          rotateEnabled={false}
          pitchEnabled={false}
          onPanDrag={() => setFollow(false)}>
          {target && (
            <>
              <Circle center={target} radius={arriveR} strokeColor="#4ADE80" fillColor="rgba(74,222,128,0.15)" strokeWidth={2} />
              <Marker coordinate={target} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={false}>
                <View style={styles.target}>
                  <View style={styles.targetH} />
                  <View style={styles.targetV} />
                </View>
              </Marker>
            </>
          )}
          {fix && target && (
            <>
              <Polyline coordinates={[fix, target]} strokeColor={lineColor} strokeWidth={3} lineDashPattern={[8, 6]} />
              {/* North-up map, so the arrow at your position points along the true bearing. */}
              <Marker coordinate={fix} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges>
                <View style={styles.youArrow}>
                  <Arrow size={40} color={lineColor} rotate={brg ?? 0} />
                </View>
              </Marker>
            </>
          )}
        </MapView>

        {/* Stake-out HUD */}
        {dist != null && brg != null && ne && (
          <View style={[styles.hud, { borderColor: lineColor }]} pointerEvents="none">
            <Text style={[styles.hudDist, { color: lineColor }]}>{formatDistance(dist)}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.hudLine}>
                {brg.toFixed(0)}° {compassPoint(brg)}
                {fix?.accuracy != null ? `   GPS ±${fix.accuracy.toFixed(0)} m` : ''}
              </Text>
              <Text style={styles.hudLine}>
                {fmtOff(ne.north, 'N', 'S')}   {fmtOff(ne.east, 'E', 'W')}
              </Text>
            </View>
          </View>
        )}

        {!follow && (
          <Pressable style={styles.recenter} onPress={() => { lastFit.current = null; setFollow(true); }}>
            <Text style={{ color: '#fff', fontWeight: '700' }}>Re-centre</Text>
          </Pressable>
        )}
      </View>

      <View style={styles.body}>
        {denied ? (
          <Text style={{ color: c.warn }}>Location permission is off — enable it in Settings to navigate.</Text>
        ) : dist == null ? (
          <Text style={{ color: c.muted }}>Getting a GPS fix…</Text>
        ) : (
          <>
            <View style={styles.row}>
              <View style={[styles.arrowWrap, { borderColor: arrived ? c.good : c.line }]}>
                {arrived ? (
                  <View style={[styles.dot, { backgroundColor: c.good }]} />
                ) : (
                  <Arrow size={52} color={c.text} rotate={turn ?? 0} />
                )}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.text, fontSize: 17, fontWeight: '700' }}>
                  {turn == null
                    ? 'Compass not ready'
                    : arrived
                      ? 'You’re on the point'
                      : Math.abs(turn) < 15
                        ? 'Straight ahead'
                        : `Turn ${turn > 0 ? 'right' : 'left'} ${Math.abs(turn).toFixed(0)}°`}
                </Text>
                {local && !arrived && (
                  <Text style={{ color: c.muted, marginTop: 2 }}>
                    {fmtOff(local.forward, 'ahead', 'behind')} · {fmtOff(local.right, 'right', 'left')}
                  </Text>
                )}
                {arrived && (
                  <Text style={{ color: c.muted, marginTop: 2 }}>Within GPS accuracy — fine-tune with the ghost.</Text>
                )}
              </View>
              {ref && <Image source={{ uri: ref.uri }} style={styles.ref} contentFit="cover" />}
            </View>
            {station?.heading != null && (
              <Text style={{ color: c.muted, marginTop: 4 }}>
                Original faced {station.heading.toFixed(0)}° {compassPoint(station.heading)}.
              </Text>
            )}
          </>
        )}

        <View style={{ flex: 1 }} />
        <Btn title="Open camera with ghost overlay" onPress={() => router.push(`/capture/${sid}`)} />
        {dist != null && dist > 500 && (
          <Btn title="Directions in Maps" kind="secondary" onPress={openMaps} style={{ marginTop: 10 }} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, padding: 16, paddingBottom: 34, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  arrowWrap: { width: 76, height: 76, borderRadius: 38, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 28, height: 28, borderRadius: 14 },
  ref: { width: 60, height: 80, borderRadius: 8 },
  hud: {
    position: 'absolute',
    top: 10,
    left: 10,
    right: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 2,
    backgroundColor: 'rgba(0,0,0,0.7)',
  },
  hudDist: { fontSize: 30, fontWeight: '800', fontVariant: ['tabular-nums'] },
  hudLine: { color: '#fff', fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  recenter: {
    position: 'absolute',
    right: 10,
    bottom: 10,
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
  },
  youArrow: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  target: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  targetH: { position: 'absolute', width: 30, height: 3, backgroundColor: '#fff' },
  targetV: { position: 'absolute', width: 3, height: 30, backgroundColor: '#fff' },
});
