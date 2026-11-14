import { Image } from 'expo-image';
import { router, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActionSheetIOS, Alert, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { StampEditor, type StampSettings } from '@/components/stamp';
import { Btn, fmtDate, useColors } from '@/components/ui';
import {
  deleteCapture,
  deleteStation,
  getStation,
  listCaptures,
  parseMarkers,
  setReference,
  updateCaptureStamp,
  updateStation,
  type Capture,
  type Station,
} from '@/lib/db';
import { alignmentAvailable, alignStation, type AlignProgress } from '@/lib/align';
import { exportStationZip, shareFile } from '@/lib/export';
import { compassPoint } from '@/lib/geo';
import { deleteCaptureFile, shareStationCsv } from '@/lib/storage';

export default function StationScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const sid = Number(id);
  const c = useColors();
  const [station, setStation] = useState<Station | null>(null);
  const [caps, setCaps] = useState<Capture[]>([]);
  const [editing, setEditing] = useState<Capture | null>(null);
  const [aligning, setAligning] = useState<AlignProgress | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);

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

  const makeReference = async (cap: Capture) => {
    await setReference(sid, cap.id);
    // The reference also defines where to stand / which way to look.
    await updateStation(sid, {
      lat: cap.lat ?? station.lat,
      lon: cap.lon ?? station.lon,
      heading: cap.heading ?? station.heading,
      pitch: cap.pitch ?? station.pitch,
      roll: cap.roll ?? station.roll,
      orientation: cap.orientation ?? station.orientation,
    });
    await load();
    // Everything has to be re-registered to the new reference.
    if (alignmentAvailable) runAlign();
  };

  const removeCapture = (cap: Capture) =>
    Alert.alert(
      'Remove this photo from the station?',
      cap.source === 'app'
        ? 'The copy kept by EnvRevisit is deleted. A copy saved to Photos is not affected.'
        : 'The photo stays in your camera roll.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            await deleteCapture(cap.id);
            deleteCaptureFile(cap);
            load();
          },
        },
      ]
    );

  const onCaptureMenu = (cap: Capture) => {
    const isRef = cap.id === ref?.id;
    const items: { label: string; run: () => void; destructive?: boolean }[] = [
      isRef
        ? { label: 'Alignment markers', run: () => router.push(`/markers/${cap.id}`) }
        : { label: 'Align by hand with markers', run: () => router.push(`/markers/${cap.id}`) },
      { label: 'Edit stamp notes', run: () => setEditing(cap) },
    ];
    if (!isRef) items.push({ label: 'Use as alignment reference', run: () => makeReference(cap) });
    items.push({ label: 'Remove from station', run: () => removeCapture(cap), destructive: true });

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...items.map((x) => x.label), 'Cancel'],
          destructiveButtonIndex: items.findIndex((x) => x.destructive),
          cancelButtonIndex: items.length,
          title: fmtDate(cap.taken_at),
        },
        (i) => items[i]?.run()
      );
    } else {
      Alert.alert(fmtDate(cap.taken_at), undefined, [
        ...items.map((x) => ({ text: x.label, onPress: x.run, style: x.destructive ? ('destructive' as const) : undefined })),
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    }
  };

  const showStamps = (station.show_stamps ?? 1) === 1;
  const hasStamps = caps.some((x) => x.note1 || x.note2 || x.stamp_date);
  const saveNotes = async (st: StampSettings) => {
    if (!editing) return;
    const on = st.enabled;
    await updateCaptureStamp(editing.id, on ? st.note1.trim() || null : null, on ? st.note2.trim() || null : null, on && st.showDate);
    setEditing(null);
    load();
  };

  async function runAlign() {
    if (aligning) return;
    setAligning({ done: 0, total: caps.length, ok: 0, failed: 0 });
    try {
      const res = await alignStation(sid, setAligning);
      if (res.failed) {
        Alert.alert(
          'Alignment finished',
          `${res.ok} aligned, ${res.failed} couldn't be aligned. Those usually differ too much from the reference (very different viewpoint, season, light or lens).`
        );
      }
    } catch (e) {
      Alert.alert('Alignment failed', String(e));
    } finally {
      setAligning(null);
      load();
    }
  }

  const exportZip = async () => {
    if (exporting) return;
    setExporting('Preparing…');
    try {
      const res = await exportStationZip(station, (done, total) => setExporting(`Copying ${done} / ${total}…`));
      if (!res.ok) Alert.alert("Couldn't export", res.reason);
      else {
        if (res.missing) {
          Alert.alert('Some photos were left out', `${res.missing} original photo(s) couldn't be read (they may be in iCloud only).`);
        }
        await shareFile(res.uri, 'application/zip', 'public.zip-archive');
      }
    } catch (e) {
      Alert.alert("Couldn't export", String(e instanceof Error ? e.message : e));
    } finally {
      setExporting(null);
    }
  };

  const nAligned = caps.filter((x) => x.align_status === 'ok').length;
  const nFailed = caps.filter((x) => x.align_status === 'failed').length;

  const remove = () =>
    Alert.alert('Delete station?', 'Photos in your camera roll are not deleted. Photos taken in EnvRevisit are kept in Photos if you saved them there.', [
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
      <Stack.Screen options={{ title: 'Station' }} />
      <View style={styles.nameRow}>
        <Text style={{ color: c.text, fontSize: 22, fontWeight: '800', flex: 1 }} numberOfLines={2}>
          {station.name}
        </Text>
        <Pressable onPress={rename} hitSlop={10} style={[styles.renameBtn, { borderColor: c.line }]}>
          <Text style={{ color: c.accent, fontWeight: '700' }}>✎ Rename</Text>
        </Pressable>
      </View>
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
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Btn
          title={`Timeline (${caps.length})`}
          kind="secondary"
          style={{ flex: 1 }}
          disabled={caps.length < 1}
          onPress={() => router.push(`/timeline/${sid}`)}
        />
        <Btn
          title={ref && parseMarkers(ref).length ? `⌖ Markers (${parseMarkers(ref).length})` : '⌖ Add markers'}
          kind="secondary"
          style={{ flex: 1 }}
          disabled={!ref}
          onPress={() => ref && router.push(`/markers/${ref.id}`)}
        />
      </View>

      <View style={styles.sectionHead}>
        <Text style={{ color: c.text, fontWeight: '700', fontSize: 17 }}>Time series</Text>
        <Pressable onPress={() => router.push(`/add-photos/${sid}`)} hitSlop={10}>
          <Text style={{ color: c.accent, fontWeight: '600' }}>+ Add older photos</Text>
        </Pressable>
      </View>
      <View style={styles.grid}>
        {caps.map((cap) => (
          <Pressable
            key={cap.id}
            style={styles.cell}
            onPress={() => router.push({ pathname: '/timeline/[id]', params: { id: String(sid), start: String(cap.id) } })}
            onLongPress={() => onCaptureMenu(cap)}>
            <View>
              <Image source={{ uri: cap.uri }} style={styles.cellImg} contentFit="cover" recyclingKey={cap.uri} />
              {cap.align_status && !cap.is_reference && (
                <View style={[styles.alignBadge, { backgroundColor: cap.align_status === 'ok' ? c.good : c.warn }]}>
                  <Text style={{ color: '#fff', fontSize: 9, fontWeight: '800' }}>{cap.align_status === 'ok' ? '⇄' : '!'}</Text>
                </View>
              )}
              {showStamps && (cap.note1 || cap.note2) && (
                <View style={[styles.noteBadge, { backgroundColor: c.accent }]}>
                  <Text style={{ color: c.accentText, fontSize: 9, fontWeight: '800' }}>✎</Text>
                </View>
              )}
            </View>
            {!!cap.is_reference && (
              <View style={[styles.badge, { backgroundColor: c.accent }]}>
                <Text style={{ color: c.accentText, fontSize: 9, fontWeight: '800' }}>REF</Text>
              </View>
            )}
            <View style={styles.cellFoot}>
              <Text style={{ color: c.text, fontSize: 12 }}>{fmtDate(cap.taken_at)}</Text>
              <Pressable onPress={() => onCaptureMenu(cap)} hitSlop={10}>
                <Text style={{ color: c.muted, fontSize: 16, fontWeight: '900' }}>⋯</Text>
              </Pressable>
            </View>
          </Pressable>
        ))}
      </View>
      <Text style={{ color: c.muted, fontSize: 12 }}>
        Tap ⋯ under a photo for markers, aligning it by hand, stamp notes, making it the reference, or removing it.
      </Text>
      {hasStamps && (
        <View style={[styles.switchRow, { borderColor: c.line, backgroundColor: c.card }]}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: c.text, fontWeight: '600' }}>Show stamps on photos</Text>
            <Text style={{ color: c.muted, fontSize: 12 }}>Notes and dates for the whole sequence. Originals are never altered.</Text>
          </View>
          <Switch
            value={showStamps}
            onValueChange={async (v) => {
              await updateStation(sid, { show_stamps: v ? 1 : 0 });
              load();
            }}
          />
        </View>
      )}

      <View style={[styles.switchRow, { borderColor: c.line, backgroundColor: c.card }]}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.text, fontWeight: '600' }}>Automatic alignment</Text>
          <Text style={{ color: c.muted, fontSize: 12 }}>
            {!alignmentAvailable
              ? 'Needs the EnvRevisit app build — not available in Expo Go.'
              : aligning
                ? `Aligning… ${aligning.done} / ${aligning.total}`
                : `${nAligned} of ${caps.length} aligned to the reference${nFailed ? ` · ${nFailed} couldn't be aligned` : ''}`}
          </Text>
        </View>
        <Btn
          small
          title={aligning ? '…' : nAligned ? 'Re-align' : 'Align'}
          disabled={!alignmentAvailable || !!aligning || caps.length < 2}
          onPress={runAlign}
        />
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Btn
          title={exporting ?? 'Export station (zip)'}
          kind="secondary"
          style={{ flex: 1.4 }}
          disabled={!!exporting || !caps.length}
          onPress={exportZip}
        />
        <Btn title="Log (CSV)" kind="secondary" style={{ flex: 1 }} onPress={() => shareStationCsv(station)} />
      </View>
      <Text style={{ color: c.muted, fontSize: 12 }}>
        The zip holds the original photos, the aligned copies, a CSV and a JSON file with positions, angles, notes and
        markers.
      </Text>
      <Btn title="Delete station" kind="ghost" onPress={remove} />
      {editing && (
        <StampEditor
          visible
          title={`Stamp — ${fmtDate(editing.taken_at)}`}
          initial={{
            enabled: !!(editing.note1 || editing.note2 || editing.stamp_date),
            note1: editing.note1 ?? '',
            note2: editing.note2 ?? '',
            showDate: editing.stamp_date ? true : !(editing.note1 || editing.note2),
          }}
          onClose={() => setEditing(null)}
          onSave={saveNotes}
        />
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  renameBtn: { borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { width: '31.5%' },
  cellFoot: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 3 },
  cellImg: { width: '100%', aspectRatio: 1, borderRadius: 8 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, borderWidth: 1 },
  alignBadge: { position: 'absolute', left: 4, bottom: 4, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 },
  noteBadge: { position: 'absolute', right: 4, top: 4, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 },
  badge: { position: 'absolute', left: 4, top: 4, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 },
});
