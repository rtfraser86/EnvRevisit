import { Image } from 'expo-image';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Btn, fmtDateTime, useColors } from '@/components/ui';
import { addCapture, createStation, getPhoto, stationIdsForAsset, type PhotoRow } from '@/lib/db';
import { compassPoint } from '@/lib/geo';
import { orientationOf, readPose, type PhotoPose } from '@/lib/library';

export default function PhotoScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const c = useColors();
  const [photo, setPhoto] = useState<PhotoRow | null>(null);
  const [pose, setPose] = useState<PhotoPose | null>(null);
  const [stationIds, setStationIds] = useState<number[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!id) return;
    getPhoto(id).then(setPhoto);
    readPose(id).then(setPose);
    stationIdsForAsset(id).then(setStationIds);
  }, [id]);

  const makeStation = async (thenNavigate: boolean) => {
    if (!photo) return;
    setBusy(true);
    try {
      const sid = await createStation({
        name: name.trim() || `Station ${new Date(photo.created).toLocaleDateString()}`,
        lat: photo.lat,
        lon: photo.lon,
        heading: pose?.attitude?.heading ?? pose?.heading ?? null,
        pitch: pose?.attitude?.pitch ?? null,
        roll: pose?.attitude?.roll ?? null,
        orientation: orientationOf(photo.width, photo.height),
        notes: null,
      });
      await addCapture({
        station_id: sid,
        uri: photo.id,
        source: 'library',
        taken_at: photo.created,
        lat: photo.lat,
        lon: photo.lon,
        accuracy: pose?.hAccuracy ?? null,
        heading: pose?.attitude?.heading ?? pose?.heading ?? null,
        pitch: pose?.attitude?.pitch ?? null,
        roll: pose?.attitude?.roll ?? null,
        width: photo.width,
        height: photo.height,
        orientation: orientationOf(photo.width, photo.height),
        is_reference: 1,
      });
      router.replace(thenNavigate ? `/navigate/${sid}` : `/station/${sid}`);
    } catch (e) {
      Alert.alert('Could not create station', String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!id) return null;
  const aspect = photo?.width && photo?.height ? photo.width / photo.height : 3 / 4;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 14, gap: 14 }}>
      <Stack.Screen options={{ title: photo ? fmtDateTime(photo.created) : 'Photo' }} />
      <Image source={{ uri: id }} style={{ width: '100%', aspectRatio: aspect, borderRadius: 12 }} contentFit="contain" />

      <View style={[styles.card, { backgroundColor: c.card, borderColor: c.line }]}>
        <Info c={c} k="Taken" v={fmtDateTime(photo?.created)} />
        <Info c={c} k="Position" v={photo ? `${photo.lat.toFixed(6)}, ${photo.lon.toFixed(6)}` : '—'} />
        <Info c={c} k="GPS accuracy" v={pose?.hAccuracy != null ? `± ${pose.hAccuracy.toFixed(0)} m` : 'not recorded'} />
        <Info
          c={c}
          k="Camera heading"
          v={
            pose?.heading != null
              ? `${pose.heading.toFixed(0)}° ${compassPoint(pose.heading)} (${pose.headingRef === 'M' ? 'magnetic' : 'true'})`
              : 'not recorded'
          }
        />
        <Info
          c={c}
          k="Pitch / roll"
          v={
            pose?.attitude?.pitch != null
              ? `${pose.attitude.pitch.toFixed(1)}° / ${(pose.attitude.roll ?? 0).toFixed(1)}°`
              : 'not in camera-roll photos — set on your first revisit'
          }
        />
      </View>

      {stationIds.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: c.muted }}>This photo is already part of a station.</Text>
          {stationIds.map((sid) => (
            <Btn key={sid} title={`Open station #${sid}`} onPress={() => router.replace(`/station/${sid}`)} />
          ))}
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Station name (e.g. Gully 3 photopoint)"
            placeholderTextColor={c.muted}
            style={[styles.input, { color: c.text, borderColor: c.line, backgroundColor: c.card }]}
          />
          <Btn title="Revisit this spot" disabled={!photo || busy} onPress={() => makeStation(true)} />
          <Btn title="Save as station only" kind="secondary" disabled={!photo || busy} onPress={() => makeStation(false)} />
        </View>
      )}
    </ScrollView>
  );
}

function Info({ c, k, v }: { c: ReturnType<typeof useColors>; k: string; v: string }) {
  return (
    <View style={styles.info}>
      <Text style={{ color: c.muted, width: 120 }}>{k}</Text>
      <Text style={{ color: c.text, flex: 1, fontWeight: '500' }}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: 1, padding: 12, gap: 8 },
  info: { flexDirection: 'row', gap: 8 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, height: 46, fontSize: 16 },
});
