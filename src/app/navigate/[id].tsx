import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Linking, Platform, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';

import { Btn, useColors } from '@/components/ui';
import { getReference, getStation, type Capture, type Station } from '@/lib/db';
import { angleDiff, bearingDeg, compassPoint, distanceM, formatDistance } from '@/lib/geo';
import { useAttitude, usePosition } from '@/lib/sensors';

export default function Navigate() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const sid = Number(id);
  const c = useColors();
  const [station, setStation] = useState<Station | null>(null);
  const [ref, setRef] = useState<Capture | null>(null);
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
  const turn = brg != null && att.heading != null ? angleDiff(brg, att.heading) : null;
  // "Arrived" = within the GPS error circle (but never tighter than 3 m — phone GPS can't do better).
  const arriveR = Math.max(3, Math.min(fix?.accuracy ?? 8, 15));

  const arrived = dist != null && dist <= arriveR;
  useEffect(() => {
    if (arrived && !arrivedRef.current) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    arrivedRef.current = arrived;
  }, [arrived]);

  // Keep both you and the target in view (refit only after moving a few metres).
  const lastFit = useRef<{ latitude: number; longitude: number } | null>(null);
  const tLat = station?.lat;
  const tLon = station?.lon;
  useEffect(() => {
    if (!fix || tLat == null || tLon == null) return;
    if (lastFit.current && distanceM(lastFit.current, fix) < 8) return;
    lastFit.current = { latitude: fix.latitude, longitude: fix.longitude };
    mapRef.current?.fitToCoordinates([fix, { latitude: tLat, longitude: tLon }], {
      edgePadding: { top: 60, right: 60, bottom: 60, left: 60 },
      animated: true,
    });
  }, [fix, tLat, tLon]);

  const openMaps = () => {
    if (!target) return;
    const q = `${target.latitude},${target.longitude}`;
    Linking.openURL(Platform.OS === 'ios' ? `http://maps.apple.com/?daddr=${q}&dirflg=w` : `geo:${q}?q=${q}`);
  };

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ title: station?.name ?? 'Navigate' }} />
      <MapView ref={mapRef} style={{ height: '38%' }} mapType="hybrid" showsUserLocation showsCompass>
        {target && <Marker coordinate={target} pinColor="green" />}
      </MapView>

      <View style={styles.body}>
        {denied ? (
          <Text style={{ color: c.warn }}>Location permission is off — enable it in Settings to navigate.</Text>
        ) : dist == null ? (
          <Text style={{ color: c.muted }}>Getting a GPS fix…</Text>
        ) : (
          <>
            <View style={styles.row}>
              <View
                style={[
                  styles.arrowWrap,
                  { borderColor: arrived ? c.good : c.line, transform: [{ rotate: `${turn ?? 0}deg` }] },
                ]}>
                <Text style={[styles.arrow, { color: arrived ? c.good : c.text }]}>{arrived ? '●' : '▲'}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.dist, { color: arrived ? c.good : c.text }]}>{formatDistance(dist)}</Text>
                <Text style={{ color: c.muted }}>
                  {brg != null ? `${brg.toFixed(0)}° ${compassPoint(brg)}` : ''}
                  {fix?.accuracy != null ? `  ·  GPS ± ${fix.accuracy.toFixed(0)} m` : ''}
                </Text>
                <Text style={{ color: c.muted, marginTop: 2 }}>
                  {turn == null
                    ? 'Hold the phone flat to use the arrow.'
                    : arrived
                      ? 'You’re at the spot (within GPS accuracy).'
                      : Math.abs(turn) < 15
                        ? 'Straight ahead'
                        : `Turn ${turn > 0 ? 'right' : 'left'} ${Math.abs(turn).toFixed(0)}°`}
                </Text>
              </View>
              {ref && <Image source={{ uri: ref.uri }} style={styles.ref} contentFit="cover" />}
            </View>
            {arrived && station?.heading != null && (
              <Text style={{ color: c.text, marginTop: 4 }}>
                Face {station.heading.toFixed(0)}° {compassPoint(station.heading)}, then open the camera and line up the ghost.
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
  arrowWrap: { width: 84, height: 84, borderRadius: 42, borderWidth: 3, alignItems: 'center', justifyContent: 'center' },
  arrow: { fontSize: 42, fontWeight: '900', marginTop: -4 },
  dist: { fontSize: 34, fontWeight: '800' },
  ref: { width: 64, height: 86, borderRadius: 8 },
});
