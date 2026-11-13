import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { fmtDate, useColors } from '@/components/ui';
import { listStations, type StationWithStats } from '@/lib/db';
import { distanceM, formatDistance } from '@/lib/geo';
import { usePosition } from '@/lib/sensors';

export default function StationsScreen() {
  const c = useColors();
  const [stations, setStations] = useState<StationWithStats[]>([]);
  const { fix } = usePosition(true, false);

  useFocusEffect(
    useCallback(() => {
      listStations().then(setStations);
    }, [])
  );

  const rows = fix
    ? [...stations].sort(
        (a, b) =>
          distanceM(fix, { latitude: a.lat, longitude: a.lon }) - distanceM(fix, { latitude: b.lat, longitude: b.lon })
      )
    : stations;

  return (
    <FlatList
      style={{ backgroundColor: c.bg }}
      contentContainerStyle={{ padding: 12, gap: 10 }}
      data={rows}
      keyExtractor={(s) => String(s.id)}
      ListEmptyComponent={
        <Text style={{ color: c.muted, textAlign: 'center', marginTop: 40, paddingHorizontal: 30 }}>
          No stations yet. Tap a photo on the map and create a station from it, or tap “New station” on the map to start one where you are standing.
        </Text>
      }
      renderItem={({ item: s }) => (
        <Pressable
          onPress={() => router.push(`/station/${s.id}`)}
          style={[styles.row, { backgroundColor: c.card, borderColor: c.line }]}>
          {s.ref_uri ? (
            <Image source={{ uri: s.ref_uri }} style={styles.thumb} contentFit="cover" />
          ) : (
            <View style={[styles.thumb, { backgroundColor: c.line }]} />
          )}
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ color: c.text, fontWeight: '700', fontSize: 16 }} numberOfLines={1}>
              {s.name}
            </Text>
            <Text style={{ color: c.muted }}>
              {s.n} photo{s.n === 1 ? '' : 's'} · {fmtDate(s.first)} → {fmtDate(s.last)}
            </Text>
            {fix && (
              <Text style={{ color: c.muted }}>{formatDistance(distanceM(fix, { latitude: s.lat, longitude: s.lon }))} away</Text>
            )}
          </View>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12, padding: 10, borderRadius: 12, borderWidth: 1, alignItems: 'center' },
  thumb: { width: 64, height: 64, borderRadius: 8 },
});
