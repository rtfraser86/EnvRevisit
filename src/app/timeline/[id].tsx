import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { Slider } from '@/components/slider';
import { StampOverlay, stampLines } from '@/components/stamp';
import { Pill, fmtDate, fmtDateTime, useColors } from '@/components/ui';
import { alignmentAvailable } from '@/lib/align';
import { getStation, listCaptures, updateStation, type Capture, type Station } from '@/lib/db';

type Mode = 'swipe' | 'scrub' | 'compare';
type Cmp = 'split' | 'blend' | 'flicker';

export default function Timeline() {
  const { id, start, a: aParam, b: bParam, view } = useLocalSearchParams<{
    id: string;
    start?: string;
    a?: string;
    b?: string;
    view?: string;
  }>();
  const sid = Number(id);
  const c = useColors();
  const { width: winW, height: winH } = useWindowDimensions();
  const [station, setStation] = useState<Station | null>(null);
  const [caps, setCaps] = useState<Capture[]>([]);
  const [mode, setMode] = useState<Mode>(view === 'compare' ? 'compare' : 'swipe');
  const [cmp, setCmp] = useState<Cmp>(view === 'compare' ? 'flicker' : 'split');
  const [flickB, setFlickB] = useState(true);
  const [useAligned, setUseAligned] = useState(true);
  const [index, setIndex] = useState(0);
  const [scrub, setScrub] = useState(0); // 0..1 across the whole series
  const [split, setSplit] = useState(0.5);
  const [a, setA] = useState(0); // compare: left/before
  const [b, setB] = useState(0); // compare: right/after
  const listRef = useRef<FlatList<Capture>>(null);

  useEffect(() => {
    (async () => {
      setStation(await getStation(sid));
      const list = await listCaptures(sid);
      setCaps(list);
      const startIdx = start ? Math.max(0, list.findIndex((x) => String(x.id) === start)) : list.length - 1;
      setIndex(startIdx);
      setScrub(list.length > 1 ? startIdx / (list.length - 1) : 0);
      const ai = aParam ? list.findIndex((x) => String(x.id) === aParam) : -1;
      const bi = bParam ? list.findIndex((x) => String(x.id) === bParam) : -1;
      setA(ai >= 0 ? ai : 0);
      setB(bi >= 0 ? bi : Math.max(0, list.length - 1));
    })();
  }, [sid, start, aParam, bParam]);

  // A photo just taken is aligned in the background: refresh until its result is in.
  const waitingFor = bParam && alignmentAvailable ? caps.find((x) => String(x.id) === bParam) : undefined;
  const pending = !!waitingFor && !waitingFor.align_status;
  useEffect(() => {
    if (!pending) return;
    let tries = 0;
    const t = setInterval(async () => {
      tries++;
      setCaps(await listCaptures(sid));
      if (tries > 30) clearInterval(t);
    }, 2000);
    return () => clearInterval(t);
  }, [pending, sid]);

  useEffect(() => {
    if (mode !== 'compare' || cmp !== 'flicker') return;
    const t = setInterval(() => setFlickB((v) => !v), 600);
    return () => clearInterval(t);
  }, [mode, cmp]);

  const ref = caps.find((x) => x.is_reference) ?? caps[0];
  const aspect = ref?.width && ref?.height ? ref.width / ref.height : 3 / 4;
  const frameW = Math.min(winW, (winH * 0.62) * aspect);
  const frameH = frameW / aspect;

  // Scrub: crossfade between neighbouring dates.
  const scrubPos = scrub * Math.max(0, caps.length - 1);
  const lo = Math.floor(scrubPos);
  const hi = Math.min(caps.length - 1, lo + 1);
  const frac = scrubPos - lo;
  const scrubLabel = caps.length ? caps[frac < 0.5 ? lo : hi] : null;

  const dateSpan = useMemo(() => {
    if (caps.length < 2) return '';
    const yrs = (caps[caps.length - 1].taken_at - caps[0].taken_at) / (365.25 * 864e5);
    return yrs >= 1 ? `${yrs.toFixed(1)} years` : `${Math.round(yrs * 365)} days`;
  }, [caps]);

  if (!caps.length) return <View style={{ flex: 1, backgroundColor: c.bg }} />;

  const showStamps = (station?.show_stamps ?? 1) === 1;
  const hasStamps = caps.some((x) => x.note1 || x.note2 || x.stamp_date);
  const toggleStamps = async () => {
    if (!station) return;
    const v = showStamps ? 0 : 1;
    await updateStation(station.id, { show_stamps: v });
    setStation({ ...station, show_stamps: v });
  };
  const stampFor = (cap: Capture) =>
    showStamps ? (
      <StampOverlay
        lines={stampLines({ takenAt: cap.taken_at, note1: cap.note1, note2: cap.note2, showDate: !!cap.stamp_date })}
        frameWidth={frameW}
      />
    ) : null;

  const hasAligned = caps.some((x) => x.align_status === 'ok' && !x.is_reference);
  const pick = (cap: Capture) => (useAligned && cap.aligned_uri ? cap.aligned_uri : cap.uri);
  const img = (uri: string, opacity = 1) => (
    <Image
      source={{ uri }}
      style={[StyleSheet.absoluteFill, { opacity }]}
      contentFit="cover"
      transition={0}
      recyclingKey={uri}
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <Stack.Screen options={{ title: station?.name ?? 'Timeline' }} />
      <View style={styles.modes}>
        <Pill label="Swipe" active={mode === 'swipe'} onPress={() => setMode('swipe')} />
        <Pill label="Scrub" active={mode === 'scrub'} onPress={() => setMode('scrub')} />
        <Pill label="Compare" active={mode === 'compare'} onPress={() => setMode('compare')} />
        {hasAligned && (
          <Pill label={useAligned ? 'Aligned' : 'As shot'} active={useAligned} onPress={() => setUseAligned((v) => !v)} />
        )}
        {hasStamps && <Pill label={showStamps ? 'Stamps on' : 'Stamps off'} active={showStamps} onPress={toggleStamps} />}
      </View>

      <View style={{ alignItems: 'center' }}>
        {mode === 'swipe' && (
          <FlatList
            ref={listRef}
            data={caps}
            horizontal
            pagingEnabled
            initialScrollIndex={index}
            getItemLayout={(_d, i) => ({ length: winW, offset: winW * i, index: i })}
            keyExtractor={(x) => String(x.id)}
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(e) => setIndex(Math.round(e.nativeEvent.contentOffset.x / winW))}
            renderItem={({ item }) => (
              <View style={{ width: winW, alignItems: 'center' }}>
                <View style={{ width: frameW, height: frameH }}>
                  {img(pick(item))}
                  {stampFor(item)}
                </View>
              </View>
            )}
          />
        )}

        {mode === 'scrub' && (
          <View style={{ width: frameW, height: frameH }}>
            {img(pick(caps[lo]))}
            {hi !== lo && img(pick(caps[hi]), frac)}
            {stampFor(caps[frac < 0.5 ? lo : hi])}
          </View>
        )}

        {mode === 'compare' && caps[a] && caps[b] && (
          <View style={{ width: frameW, height: frameH }}>
            {cmp === 'split' && (
              <>
                {img(pick(caps[b]))}
                <View style={[StyleSheet.absoluteFill, { right: undefined, width: frameW * split, overflow: 'hidden' }]}>
                  <Image source={{ uri: pick(caps[a]) }} style={{ width: frameW, height: frameH }} contentFit="cover" transition={0} />
                </View>
                <View style={[styles.divider, { left: frameW * split - 1 }]} />
                <Text style={[styles.tag, { left: 8 }]}>{fmtDate(caps[a].taken_at)}</Text>
                <Text style={[styles.tag, { right: 8 }]}>{fmtDate(caps[b].taken_at)}</Text>
              </>
            )}
            {cmp === 'blend' && (
              <>
                {img(pick(caps[a]))}
                {img(pick(caps[b]), split)}
                <Text style={[styles.tag, { left: 8 }]}>{fmtDate(caps[a].taken_at)}</Text>
                <Text style={[styles.tag, { right: 8 }]}>{fmtDate(caps[b].taken_at)}</Text>
              </>
            )}
            {cmp === 'flicker' && (
              <>
                {img(pick(caps[a]))}
                {img(pick(caps[b]), flickB ? 1 : 0)}
                <Text style={[styles.tag, { left: 8 }]}>{fmtDate((flickB ? caps[b] : caps[a]).taken_at)}</Text>
              </>
            )}
            {pending && (
              <Text style={[styles.tag, { left: 8, top: undefined, bottom: 8 }]}>Aligning the new photo…</Text>
            )}
          </View>
        )}
      </View>

      <ScrollView style={{ flex: 1, backgroundColor: c.bg }} contentContainerStyle={{ padding: 14, gap: 12 }}>
        {mode === 'swipe' && (
          <Text style={{ color: c.text, fontWeight: '700', fontSize: 16, textAlign: 'center' }}>
            {fmtDateTime(caps[index]?.taken_at)}  ·  {index + 1} / {caps.length}
          </Text>
        )}
        {mode === 'scrub' && (
          <>
            <Text style={{ color: c.text, fontWeight: '700', fontSize: 16, textAlign: 'center' }}>
              {fmtDate(scrubLabel?.taken_at)}
            </Text>
            <Slider value={scrub} onChange={setScrub} trackColor={c.line} fillColor={c.accent} thumbColor={c.text} />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ color: c.muted }}>{fmtDate(caps[0].taken_at)}</Text>
              <Text style={{ color: c.muted }}>{dateSpan}</Text>
              <Text style={{ color: c.muted }}>{fmtDate(caps[caps.length - 1].taken_at)}</Text>
            </View>
          </>
        )}
        {mode === 'compare' && (
          <>
            <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'center' }}>
              {(['split', 'blend', 'flicker'] as Cmp[]).map((m) => (
                <Pill key={m} label={m[0].toUpperCase() + m.slice(1)} active={cmp === m} onPress={() => setCmp(m)} />
              ))}
            </View>
            {cmp !== 'flicker' && (
              <Slider value={split} onChange={setSplit} trackColor={c.line} fillColor={c.accent} thumbColor={c.text} />
            )}
            <Text style={{ color: c.muted }}>Tap thumbnails: first tap sets the left (before) image, second tap sets the right (after).</Text>
          </>
        )}

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          {caps.map((cap, i) => {
            const selected =
              mode === 'swipe' ? i === index : mode === 'scrub' ? i === (frac < 0.5 ? lo : hi) : i === a || i === b;
            return (
              <Pressable
                key={cap.id}
                onPress={() => {
                  if (mode === 'swipe') {
                    setIndex(i);
                    listRef.current?.scrollToIndex({ index: i, animated: true });
                  } else if (mode === 'scrub') {
                    setScrub(caps.length > 1 ? i / (caps.length - 1) : 0);
                  } else if (i < b) setA(i);
                  else setB(i);
                }}>
                <Image
                  source={{ uri: cap.uri }}
                  style={[styles.thumb, { borderColor: selected ? c.accent : 'transparent' }]}
                  contentFit="cover"
                  recyclingKey={cap.uri}
                />
                <Text style={{ color: c.muted, fontSize: 10, textAlign: 'center' }}>{fmtDate(cap.taken_at)}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
        <Text style={{ color: c.muted, fontSize: 12 }}>
          {hasAligned
            ? 'Aligned shows each photo warped onto the reference view. Black edges are areas the later photo did not cover.'
            : 'Photos are shown as captured. Use Align on the station screen (EnvRevisit build) to register them to the reference.'}
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  modes: { flexDirection: 'row', justifyContent: 'center', gap: 8, paddingVertical: 10 },
  divider: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: '#fff' },
  tag: {
    position: 'absolute',
    top: 8,
    color: '#fff',
    fontWeight: '700',
    fontSize: 12,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  thumb: { width: 64, height: 64, borderRadius: 8, borderWidth: 3 },
});
