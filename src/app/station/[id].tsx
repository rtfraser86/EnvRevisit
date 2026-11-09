import { Image } from 'expo-image';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Btn, fmtDate, useColors } from '@/components/ui';
import {
  deleteCapture,
  deleteStation,
  getStation,
  listCaptures,
  setReference,
  updateStation,
  type Capture,
  type Station,
} from '@/lib/db';
import { compassPoint } from '@/lib/geo';
import { deleteCaptureFile, shareStationCsv } from '@/lib/storage';

export default function StationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const sid = Number(id);
  const c = useColors();
  const [station, setStation] = useState<Station | null>(null);
  const [caps, setCaps] = useState<Capture[]>([]);

  const load = useCallback(async () => {
    setStation(await getStation(sid));
    setCaps(await listCaptures(sid));
  }, [sid]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  if (!station) return <View style={{ flex: 1, backgroundColor: c.bg }} />;

  const ref = caps.find((x) => x.is_reference) ?? caps[0];

  const rename = () =>
    Alert.prompt?.(
      'Rename station',
      undefined,
      async (t) => {
        if (t?.trim()) {
          await updateStation(sid, { name: t.trim() });
          load();
        }
      },
      'plain-text',
      station.name
    );

  const onCaptureMenu = (cap: Capture) => {
    const options = ['Use as alignment reference', 'Remove from station', 'Cancel'];
    const act = async (i: number) => {
      if (i === 0) {
        await setReference(sid, cap.id);
        // The reference also defines where to stand / which way to look.
        await updateStation(sid, {
          lat: cap.lat ?? station.lat,
          lon: cap.lon ?? station.lon,
          heading: cap.heading ?? station.heading,
          pitch: cap.pitch ?? station.pitch,
          roll: cap.roll ?? station.roll,
        });
      } else if (i === 1) {
        await deleteCapture(cap.id);
        deleteCaptureFile(cap);
      }
      load();
    };
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, destructiveButtonIndex: 1, cancelButtonIndex: 2, title: fmtDate(cap.taken_at) },
        act
      );
    } else {
      Alert.alert(fmtDate(cap.taken_at), undefined, [
        { text: options[0], onPress: () => act(0) },
        { text: options[1], style: 'destructive', onPress: () => act(1) },
        { text: 'Cancel', style: 'cancel' },
      ]);
    }
  };

  const remove = () =>
    Alert.alert('Delete station?', 'Photos in your camera roll are not deleted. Photos taken in Revisit are kept in Photos if you saved them there.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          caps.forEach(deleteCaptureFile);
          await deleteStation(sid);
          router.back();
        },
      },
    ]);

  const aspect = ref?.width && ref?.height ? ref.width / ref.height : 3 / 4;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 14, gap: 14 }}>
      <Stack.Screen
        options={{
          title: station.name,
          headerRight: () => (
            <Pressable onPress={rename} hitSlop={10}>
              <Text style={{ color: c.accent, fontWeight: '600' }}>Rename</Text>
            </Pressable>
          ),
        }}
      />
      {ref && (
        <Pressable onPress={() => router.push(`/timeline/${sid}`)}>
          <Image source={{ uri: ref.uri }} style={{ width: '100%', aspectRatio: aspect, borderRadius: 12 }} contentFit="cover" />
        </Pressable>
      )}

      <Text style={{ color: c.muted }}>
        {station.lat.toFixed(6)}, {station.lon.toFixed(6)}
        {station.heading != null ? `  ·  facing ${station.heading.toFixed(0)}° ${compassPoint(station.heading)}` : ''}
        {station.pitch != null ? `  ·  pitch ${station.pitch.toFixed(1)}°` : ''}
      </Text>

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Btn title="Navigate" kind="secondary" style={{ flex: 1 }} onPress={() => router.push(`/navigate/${sid}`)} />
        <Btn title="Retake now" style={{ flex: 1 }} onPress={() => router.push(`/capture/${sid}`)} />
      </View>
      <Btn
        title={`Timeline viewer (${caps.length})`}
        kind="secondary"
        disabled={caps.length < 1}
        onPress={() => router.push(`/timeline/${sid}`)}
      />

      <View style={styles.sectionHead}>
        <Text style={{ color: c.text, fontWeight: '700', fontSize: 17 }}>Time series</Text>
        <Pressable onPress={() => router.push(`/add-photos/${sid}`)} hitSlop={10}>
          <Text style={{ color: c.accent, fontWeight: '600' }}>+ Add older photos</Text>
        </Pressable>
      </View>
      <View style={styles.grid}>
        {caps.map((cap) => (
          <Pressable key={cap.id} style={styles.cell} onPress={() => router.push({ pathname: '/timeline/[id]', params: { id: String(sid), start: String(cap.id) } })} onLongPress={() => onCaptureMenu(cap)}>
            <Image source={{ uri: cap.uri }} style={styles.cellImg} contentFit="cover" recyclingKey={cap.uri} />
            {!!cap.is_reference && (
              <View style={[styles.badge, { backgroundColor: c.accent }]}>
                <Text style={{ color: c.accentText, fontSize: 9, fontWeight: '800' }}>REF</Text>
              </View>
            )}
            <Text style={{ color: c.text, fontSize: 12, marginTop: 3 }}>{fmtDate(cap.taken_at)}</Text>
          </Pressable>
        ))}
      </View>
      <Text style={{ color: c.muted, fontSize: 12 }}>Long-press a photo to make it the alignment reference or remove it.</Text>

      <Btn title="Export capture log (CSV)" kind="secondary" onPress={() => shareStationCsv(station)} />
      <Btn title="Delete station" kind="ghost" onPress={remove} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { width: '31.5%' },
  cellImg: { width: '100%', aspectRatio: 1, borderRadius: 8 },
  badge: { position: 'absolute', left: 4, top: 4, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 },
});
