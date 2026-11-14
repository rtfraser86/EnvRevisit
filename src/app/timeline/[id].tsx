import { Image } from 'expo-image';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Sharing from 'expo-sharing';
import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { captureRef } from 'react-native-view-shot';

import { Slider } from '@/components/slider';
import { StampOverlay, stampLines } from '@/components/stamp';
import { Pill, fmtDate, fmtDateTime, useColors } from '@/components/ui';
import { alignmentAvailable, changeMapFor, exportTimelapse, type ChangeMap } from '@/lib/align';
import { safeName, shareFile } from '@/lib/export';
import { getStation, listCaptures, parseMask, updateStation, type Capture, type MaskRect, type Station } from '@/lib/db';

type Mode = 'swipe' | 'scrub' | 'compare';
type Cmp = 'split' | 'blend' | 'flicker' | 'change';
/** Swipe mode: what to show over the photo you've swiped to. */
type Over = 'off' | 'flicker' | 'slider' | 'fade';
type Against = 'previous' | 'reference' | 'first';
const CHANGE_COLOUR = '#FF2D95';

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
  const [over, setOver] = useState<Over>('off');
  const [against, setAgainst] = useState<Against>('previous');
  const [overT, setOverT] = useState(0.5);
  const insets = useSafeAreaInsets();
  const [useAligned, setUseAligned] = useState(true);
  const [index, setIndex] = useState(0);
  const [scrub, setScrub] = useState(0); // 0..1 across the whole series
  const [split, setSplit] = useState(0.5);
  const [a, setA] = useState(0); // compare: left/before
  const [b, setB] = useState(0); // compare: right/after
  const [slot, setSlot] = useState<'a' | 'b'>('a'); // compare: which side the next thumbnail tap sets
  const [heat, setHeat] = useState<{ key: string; map: ChangeMap } | null>(null);
  const [exporting, setExporting] = useState<string | null>(null);
  const [maskEdit, setMaskEdit] = useState(false);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const listRef = useRef<FlatList<Capture>>(null);
  const shotRef = useRef<ComponentRef<typeof View>>(null);

  /** Time-lapse of the whole series as a video or GIF, each photo labelled with its date. */
  const shareTimelapse = async (format: 'mp4' | 'gif') => {
    if (exporting) return;
    setExporting(format === 'mp4' ? 'Making video…' : 'Making GIF…');
    try {
      const stamps = (station?.show_stamps ?? 1) === 1;
      const labels = caps.map((cap) =>
        [fmtDate(cap.taken_at), ...(stamps ? [cap.note1, cap.note2].filter((x): x is string => !!x?.trim()) : [])].join('\n')
      );
      const name = `${safeName(station?.name ?? '', `station_${sid}`)}_timelapse`;
      const res = await exportTimelapse(caps, labels, format, name, useAligned);
      if (!res.ok) Alert.alert("Couldn't export", res.reason);
      else if (format === 'mp4') await shareFile(res.uri, 'video/mp4', 'public.mpeg-4');
      else await shareFile(res.uri, 'image/gif', 'com.compuserve.gif');
    } catch (e) {
      Alert.alert("Couldn't export", String(e instanceof Error ? e.message : e));
    } finally {
      setExporting(null);
    }
  };

  const exportMenu = () => {
    const items: [string, () => void][] = [
      ['Share this view (image)', () => shareView()],
      ['Time-lapse video (MP4)', () => shareTimelapse('mp4')],
      ['Animated GIF', () => shareTimelapse('gif')],
    ];
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options: [...items.map((x) => x[0]), 'Cancel'], cancelButtonIndex: items.length, title: 'Export' },
        (i) => items[i]?.[1]()
      );
    } else {
      Alert.alert('Export', undefined, [
        ...items.map((x) => ({ text: x[0], onPress: x[1] })),
        { text: 'Cancel', style: 'cancel' as const },
      ]);
    }
  };

  /** Share the picture currently on screen (with its date labels and stamps). */
  const shareView = async () => {
    try {
      const uri = await captureRef(shotRef as Parameters<typeof captureRef>[0], { format: 'jpg', quality: 0.92 });
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { mimeType: 'image/jpeg', UTI: 'public.jpeg' });
    } catch (e) {
      Alert.alert('Could not share', String(e instanceof Error ? e.message : e));
    }
  };

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

  // Change map for the two photos being compared (worked out when the Change view is opened).
  const capA = caps[a];
  const capB = caps[b];
  const mask = useMemo(() => parseMask(station), [station]);
  const heatKey =
    capA && capB ? `${capA.id}:${capA.aligned_uri ?? ''}|${capB.id}:${capB.aligned_uri ?? ''}|${station?.change_mask ?? ''}` : '';
  const wantHeat = mode === 'compare' && cmp === 'change' && !!heatKey && heat?.key !== heatKey;
  useEffect(() => {
    if (!wantHeat || !capA || !capB) return;
    let cancelled = false;
    changeMapFor(capA, capB, mask)
      .catch((e): ChangeMap => ({ ok: false, reason: String(e instanceof Error ? e.message : e) }))
      .then((map) => !cancelled && setHeat({ key: heatKey, map }));
    return () => {
      cancelled = true;
    };
  }, [wantHeat, heatKey, capA, capB, mask]);
  const heatNow = heat && heat.key === heatKey ? heat.map : null;

  const flickering = (mode === 'compare' && cmp === 'flicker') || (mode === 'swipe' && over === 'flicker');
  useEffect(() => {
    if (!flickering) return;
    const t = setInterval(() => setFlickB((v) => !v), 600);
    return () => clearInterval(t);
  }, [flickering]);

  const ref = caps.find((x) => x.is_reference) ?? caps[0];
  const aspect = ref?.width && ref?.height ? ref.width / ref.height : 3 / 4;
  const frameW = Math.min(winW, (winH - insets.top) * 0.56 * aspect);
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

  /** The photo the swiped-to photo is compared with in Swipe → Flicker / Slider / Fade. */
  const otherFor = (i: number): Capture | null => {
    const refIdx = caps.findIndex((x) => x.is_reference);
    const j = against === 'previous' ? i - 1 : against === 'first' ? 0 : refIdx >= 0 ? refIdx : 0;
    if (j === i) return against === 'previous' ? null : i + 1 < caps.length ? caps[i + 1] : null;
    return j >= 0 ? caps[j] : null;
  };

  const saveMask = async (next: MaskRect[]) => {
    if (!station) return;
    const v = next.length ? JSON.stringify(next.map((r) => ({ x: +r.x.toFixed(4), y: +r.y.toFixed(4), w: +r.w.toFixed(4), h: +r.h.toFixed(4) }))) : null;
    await updateStation(station.id, { change_mask: v });
    setStation({ ...station, change_mask: v });
  };
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const dragRect = drag
    ? {
        x: Math.min(drag.x0, drag.x1),
        y: Math.min(drag.y0, drag.y1),
        w: Math.abs(drag.x1 - drag.x0),
        h: Math.abs(drag.y1 - drag.y0),
      }
    : null;
  const onMaskRelease = () => {
    if (!drag || !dragRect) return;
    setDrag(null);
    if (dragRect.w * frameW < 12 && dragRect.h * frameH < 12) {
      // A tap: remove the masked area under the finger.
      const hit = mask.findIndex((r) => drag.x0 >= r.x && drag.x0 <= r.x + r.w && drag.y0 >= r.y && drag.y0 <= r.y + r.h);
      if (hit >= 0) saveMask(mask.filter((_r, i) => i !== hit));
      return;
    }
    saveMask([...mask, dragRect]);
  };
  const maskBox = (r: MaskRect, key: string | number, live = false) => (
    <View
      key={key}
      pointerEvents="none"
      style={[
        styles.maskBox,
        { left: r.x * frameW, top: r.y * frameH, width: r.w * frameW, height: r.h * frameH },
        live && { borderStyle: 'dashed' },
      ]}>
      {r.w * frameW > 60 && r.h * frameH > 22 && <Text style={styles.maskText}>ignored</Text>}
    </View>
  );

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
      {/* Own top bar (the native header hid these buttons under the status bar on some phones). */}
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar hidden={false} style="light" />
      <View style={[styles.topBar, { paddingTop: insets.top + 4 }]}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back}>
          <Text style={styles.backText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {station?.name ?? 'Timeline'}
        </Text>
        <View style={{ width: 64 }} />
      </View>
      <View style={styles.modes}>
        <Pill label="Swipe" active={mode === 'swipe'} onPress={() => setMode('swipe')} />
        <Pill label="Scrub" active={mode === 'scrub'} onPress={() => setMode('scrub')} />
        <Pill label="Compare" active={mode === 'compare'} onPress={() => setMode('compare')} />
        {hasAligned && (
          <Pill label={useAligned ? 'Aligned' : 'As shot'} active={useAligned} onPress={() => setUseAligned((v) => !v)} />
        )}
        {hasStamps && <Pill label={showStamps ? 'Stamps on' : 'Stamps off'} active={showStamps} onPress={toggleStamps} />}
        <Pill label={exporting ?? 'Export ▾'} onPress={exportMenu} />
      </View>

      <View ref={shotRef} collapsable={false} style={{ alignItems: 'center', backgroundColor: '#000' }}>
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
            extraData={`${over}|${against}|${overT}|${flickB}|${useAligned}|${showStamps}`}
            renderItem={({ item, index: i }) => {
              const other = over !== 'off' ? otherFor(i) : null;
              const otherOn = other && over === 'flicker' && !flickB;
              return (
                <View style={{ width: winW, alignItems: 'center' }}>
                  <View style={{ width: frameW, height: frameH }}>
                    {img(pick(item))}
                    {other && over === 'fade' && img(pick(other), 1 - overT)}
                    {other && over === 'flicker' && img(pick(other), otherOn ? 1 : 0)}
                    {other && over === 'slider' && (
                      <>
                        <View style={[StyleSheet.absoluteFill, { right: undefined, width: frameW * overT, overflow: 'hidden' }]}>
                          <Image source={{ uri: pick(other) }} style={{ width: frameW, height: frameH }} contentFit="cover" transition={0} />
                        </View>
                        <View style={[styles.divider, { left: frameW * overT - 1 }]} />
                      </>
                    )}
                    {other ? (
                      over === 'flicker' ? (
                        <Text style={[styles.tag, { left: 8 }]}>{fmtDate((otherOn ? other : item).taken_at)}</Text>
                      ) : (
                        <>
                          <Text style={[styles.tag, { left: 8 }]}>{fmtDate(other.taken_at)}</Text>
                          <Text style={[styles.tag, { right: 8 }]}>{fmtDate(item.taken_at)}</Text>
                        </>
                      )
                    ) : (
                      !(showStamps && item.stamp_date) && <Text style={[styles.tag, { left: 8 }]}>{fmtDate(item.taken_at)}</Text>
                    )}
                    {!other && stampFor(item)}
                  </View>
                </View>
              );
            }}
          />
        )}

        {mode === 'scrub' && (
          <View style={{ width: frameW, height: frameH }}>
            {img(pick(caps[lo]))}
            {hi !== lo && img(pick(caps[hi]), frac)}
            {!(showStamps && scrubLabel?.stamp_date) && (
              <Text style={[styles.tag, { left: 8 }]}>{fmtDate(scrubLabel?.taken_at)}</Text>
            )}
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
            {cmp === 'change' && (
              <>
                {img(pick(caps[b]))}
                {heatNow?.ok && (
                  <Image
                    source={{ uri: heatNow.uri }}
                    style={[StyleSheet.absoluteFill, { opacity: 0.25 + 0.75 * split }]}
                    contentFit="cover"
                    tintColor={CHANGE_COLOUR}
                    transition={0}
                  />
                )}
                <Text style={[styles.tag, { left: 8 }]}>
                  {fmtDate(caps[a].taken_at)} → {fmtDate(caps[b].taken_at)}
                </Text>
                {heatNow?.ok && (
                  <Text style={[styles.tag, { right: 8 }]}>Change index {(heatNow.changed * 100).toFixed(1)}%</Text>
                )}
                {mask.map((r, i) => maskBox(r, i))}
                {dragRect && maskBox(dragRect, 'drag', true)}
                {maskEdit && (
                  <View
                    style={StyleSheet.absoluteFill}
                    onStartShouldSetResponder={() => true}
                    onMoveShouldSetResponder={() => true}
                    onResponderTerminationRequest={() => false}
                    onResponderGrant={(e) => {
                      const x = clamp01(e.nativeEvent.locationX / frameW);
                      const y = clamp01(e.nativeEvent.locationY / frameH);
                      setDrag({ x0: x, y0: y, x1: x, y1: y });
                    }}
                    onResponderMove={(e) => {
                      const x = clamp01(e.nativeEvent.locationX / frameW);
                      const y = clamp01(e.nativeEvent.locationY / frameH);
                      setDrag((d) => (d ? { ...d, x1: x, y1: y } : d));
                    }}
                    onResponderRelease={onMaskRelease}
                  />
                )}
                {!heatNow && (
                  <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
                    <ActivityIndicator color="#fff" />
                  </View>
                )}
                {heatNow && !heatNow.ok && (
                  <View style={styles.notice}>
                    <Text style={{ color: '#fff', fontWeight: '700', textAlign: 'center' }}>{heatNow.reason}</Text>
                  </View>
                )}
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
          <>
            <Text style={{ color: c.text, fontWeight: '700', fontSize: 16, textAlign: 'center' }}>
              {fmtDateTime(caps[index]?.taken_at)}  ·  {index + 1} / {caps.length}
            </Text>
            <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
              {(['off', 'flicker', 'slider', 'fade'] as Over[]).map((m) => (
                <Pill key={m} label={m === 'off' ? 'Single' : m[0].toUpperCase() + m.slice(1)} active={over === m} onPress={() => setOver(m)} />
              ))}
            </View>
            {over !== 'off' && (
              <>
                <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center', alignItems: 'center' }}>
                  <Text style={{ color: c.muted, fontSize: 12 }}>against</Text>
                  {(['previous', 'reference', 'first'] as Against[]).map((m) => (
                    <Pill
                      key={m}
                      label={m === 'previous' ? 'Previous' : m === 'reference' ? 'Reference' : 'Oldest'}
                      active={against === m}
                      onPress={() => setAgainst(m)}
                    />
                  ))}
                </View>
                {over !== 'flicker' && (
                  <Slider value={overT} onChange={setOverT} trackColor={c.line} fillColor={c.accent} thumbColor={c.text} />
                )}
                <Text style={{ color: c.muted, fontSize: 12, textAlign: 'center' }}>
                  {otherFor(index)
                    ? over === 'flicker'
                      ? 'Flicking between the two photos. Keep swiping to step through the series.'
                      : over === 'slider'
                        ? 'Drag the slider: left of the line is the earlier photo.'
                        : 'Drag the slider to fade between the two photos.'
                    : 'Nothing to compare with for this photo; swipe to another.'}
                </Text>
              </>
            )}
          </>
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
              {(['split', 'blend', 'flicker', 'change'] as Cmp[]).map((m) => (
                <Pill key={m} label={m[0].toUpperCase() + m.slice(1)} active={cmp === m} onPress={() => setCmp(m)} />
              ))}
            </View>
            {cmp === 'change' && (
              <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
                <Pill label={maskEdit ? '✓ Done masking' : '✎ Mask areas'} active={maskEdit} onPress={() => setMaskEdit((v) => !v)} />
                <Pill label="Mask top ⅓ (sky)" onPress={() => saveMask([...mask, { x: 0, y: 0, w: 1, h: 1 / 3 }])} />
                {mask.length > 0 && <Pill label={`Clear mask (${mask.length})`} onPress={() => saveMask([])} />}
              </View>
            )}
            {cmp !== 'flicker' && (
              <Slider value={split} onChange={setSplit} trackColor={c.line} fillColor={c.accent} thumbColor={c.text} />
            )}
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {(['a', 'b'] as const).map((k) => {
                const cap = caps[k === 'a' ? a : b];
                const on = slot === k;
                return (
                  <Pressable
                    key={k}
                    onPress={() => setSlot(k)}
                    style={[styles.slot, { borderColor: on ? c.accent : c.line, backgroundColor: c.card }]}>
                    <Text style={{ color: c.muted, fontSize: 11, fontWeight: '700' }}>{k === 'a' ? 'BEFORE' : 'AFTER'}</Text>
                    <Text style={{ color: c.text, fontWeight: '700' }}>{fmtDate(cap?.taken_at)}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={{ color: c.muted, fontSize: 12 }}>
              Tap Before or After, then tap a photo below to change it.
              {cmp === 'change'
                ? ' Pink shows where the two aligned photos differ; the slider sets how strongly it is drawn. Shadows and lighting can show up as change, so compare photos taken at a similar time of day. Mask areas such as sky or water so they are left out of the map and the change index: tap ✎ Mask areas, drag a box on the photo, tap a box to remove it. The mask is saved for the station.'
                : ''}
            </Text>
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
                  } else if (slot === 'a') {
                    setA(i);
                    setSlot('b');
                  } else {
                    setB(i);
                    setSlot('a');
                  }
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
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingBottom: 4 },
  back: { width: 64, paddingVertical: 6 },
  backText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  title: { flex: 1, color: '#fff', fontSize: 17, fontWeight: '700', textAlign: 'center' },
  modes: { flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: 6, paddingVertical: 8, paddingHorizontal: 8 },
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
  notice: {
    position: 'absolute',
    left: 16,
    right: 16,
    top: '42%',
    backgroundColor: 'rgba(0,0,0,0.75)',
    padding: 10,
    borderRadius: 10,
  },
  maskBox: {
    position: 'absolute',
    backgroundColor: 'rgba(30,41,59,0.55)',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.8)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  maskText: { color: '#fff', fontSize: 11, fontWeight: '700', opacity: 0.85 },
  slot: { flex: 1, borderWidth: 2, borderRadius: 10, paddingVertical: 6, paddingHorizontal: 10 },
});
