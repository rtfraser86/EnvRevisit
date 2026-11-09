import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Btn, Pill, fmtDate, useColors } from '@/components/ui';
import { addCapture, getStation, listCaptures, photosInBox, type PhotoRow, type Station } from '@/lib/db';
import { bbox, distanceM, formatDistance } from '@/lib/geo';
import { readPose } from '@/lib/library';

const RADII = [15, 40, 100, 250];

export default function AddPhotos() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const sid = Number(id);
  const c = useColors();
  const [station, setStation] = useState<Station | null>(null);
  const [radius, setRadius] = useState(40);
  const [candidates, setCandidates] = useState<(PhotoRow & { d: number })[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const s = await getStation(sid);
      setStation(s);
      if (!s) return;
      const existing = new Set((await listCaptures(sid)).map((x) => x.uri));
      const center = { latitude: s.lat, longitude: s.lon };
      const rows = await photosInBox(bbox(center, radius));
      setCandidates(
        rows
          .filter((p) => !existing.has(p.id))
          .map((p) => ({ ...p, d: distanceM(center, { latitude: p.lat, longitude: p.lon }) }))
          .filter((p) => p.d <= radius)
          .sort((a, b) => a.created - b.created)
      );
    })();
  }, [sid, radius]);

  const toggle = (pid: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(pid)) n.delete(pid);
      else n.add(pid);
      return n;
    });

  const add = async () => {
    setBusy(true);
    for (const p of candidates.filter((x) => picked.has(x.id))) {
      const pose = await readPose(p.id);
      await addCapture({
        station_id: sid,
        uri: p.id,
        source: 'library',
        taken_at: p.created,
        lat: p.lat,
        lon: p.lon,
        accuracy: pose.hAccuracy,
        heading: pose.attitude?.heading ?? pose.heading,
        pitch: pose.attitude?.pitch ?? null,
        roll: pose.attitude?.roll ?? null,
        width: p.width,
        height: p.height,
        is_reference: 0,
      });
    }
    setBusy(false);
    router.back();
  };

  const header = useMemo(
    () => (
      <View style={{ gap: 10, marginBottom: 10 }}>
        <Text style={{ color: c.muted }}>
          Camera-roll photos taken near “{station?.name}”. Pick the ones that show the same view to add them to the time series.
        </Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {RADII.map((r) => (
            <Pill key={r} label={`${r} m`} active={r === radius} onPress={() => setRadius(r)} />
          ))}
        </View>
      </View>
    ),
    [c.muted, station?.name, radius]
  );

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <FlatList
        data={candidates}
        numColumns={3}
        keyExtractor={(p) => p.id}
        contentContainerStyle={{ padding: 10, paddingBottom: 100 }}
        columnWrapperStyle={{ gap: 8 }}
        ListHeaderComponent={header}
        ListEmptyComponent={<Text style={{ color: c.muted, marginTop: 20 }}>No other photos within {radius} m.</Text>}
        renderItem={({ item }) => {
          const on = picked.has(item.id);
          return (
            <Pressable onPress={() => toggle(item.id)} style={{ width: '31.5%', marginBottom: 10 }}>
              <Image source={{ uri: item.id }} style={[styles.img, on && { borderColor: c.accent, borderWidth: 3 }]} contentFit="cover" recyclingKey={item.id} />
              {on && (
                <View style={[styles.tick, { backgroundColor: c.accent }]}>
                  <Text style={{ color: c.accentText, fontWeight: '900' }}>✓</Text>
                </View>
              )}
              <Text style={{ color: c.text, fontSize: 12 }}>{fmtDate(item.created)}</Text>
              <Text style={{ color: c.muted, fontSize: 11 }}>{formatDistance(item.d)}</Text>
            </Pressable>
          );
        }}
      />
      <View style={styles.footer}>
        <Btn title={busy ? 'Adding…' : `Add ${picked.size} photo${picked.size === 1 ? '' : 's'}`} disabled={!picked.size || busy} onPress={add} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  img: { width: '100%', aspectRatio: 1, borderRadius: 8 },
  tick: { position: 'absolute', right: 6, top: 6, width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  footer: { position: 'absolute', left: 12, right: 12, bottom: 30 },
});
