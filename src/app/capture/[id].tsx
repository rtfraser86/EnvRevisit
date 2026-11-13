import { CameraView, useCameraPermissions } from 'expo-camera';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { usePermissions as useMediaPermissions } from 'expo-media-library';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState, type ComponentRef } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  PixelRatio,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  AlignmentGuide,
  GuideHud,
  allAligned,
  fovFor,
  imageDeltas,
  sensorDeltas,
  type Target,
} from '@/components/alignment-guide';
import { Slider } from '@/components/slider';
import { StakeoutChip } from '@/components/stakeout';
import {
  DEFAULT_STAMP,
  StampEditor,
  StampOverlay,
  StampSnapshot,
  snapshotStamp,
  stampLines,
  type StampSettings,
} from '@/components/stamp';
import { Btn, Pill, fmtDate, useColors } from '@/components/ui';
import {
  addCapture,
  getStation,
  kvGet,
  kvSet,
  listCaptures,
  updateStation,
  type Capture,
  type Station,
} from '@/lib/db';
import {
  alignCapture,
  alignmentAvailable,
  deleteFile,
  edgesFor,
  ghostForMatching,
  matchLiveFrame,
  type LiveMatch,
} from '@/lib/align';
import { distanceM, formatDistance } from '@/lib/geo';
import { orientationOf } from '@/lib/library';
import { shotOf, useAttitude, usePosition } from '@/lib/sensors';
import { persistCapture, saveToPhotosLibrary } from '@/lib/storage';

type Mode = 'blend' | 'edges' | 'split' | 'flicker' | 'off';
const MODES: Mode[] = ['blend', 'edges', 'split', 'flicker', 'off'];
const EDGE_COLOURS = ['#22D3EE', '#F472B6', '#FACC15', '#FFFFFF'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function CaptureScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const sid = Number(id);
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  const cam = useRef<CameraView>(null);
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [mediaPerm, requestMediaPerm] = useMediaPermissions();
  const [station, setStation] = useState<Station | null>(null);
  const [caps, setCaps] = useState<Capture[]>([]);
  const [ghostId, setGhostId] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [mode, setMode] = useState<Mode>('blend');
  const [edgeColour, setEdgeColour] = useState(0);
  const [edges, setEdges] = useState<{ id: number; uri: string | null } | null>(null);
  const [liveOn, setLiveOn] = useState(alignmentAvailable);
  const [live, setLive] = useState<LiveMatch | null>(null);
  const [ghostSmall, setGhostSmall] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [lastId, setLastId] = useState<number | null>(null);
  const busyRef = useRef(false);
  const liveInFlight = useRef<Promise<void> | null>(null);
  const fovRef = useRef(fovFor(false));
  const wasAligned = useRef(false);
  const [amount, setAmount] = useState(0.5); // opacity for blend, divider for split
  const [flickOn, setFlickOn] = useState(true);
  const [grid, setGrid] = useState(true);
  const [saveToPhotos, setSaveToPhotos] = useState(true);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [stamp, setStamp] = useState<StampSettings>(DEFAULT_STAMP);
  const [editingStamp, setEditingStamp] = useState(false);
  const [now, setNow] = useState(() => Date.now()); // drives the live date on the stamp preview
  const [snapJob, setSnapJob] = useState<{ uri: string; w: number; h: number; lines: string[] } | null>(null);
  const snapView = useRef<ComponentRef<typeof View>>(null);
  const snapResolve = useRef<((uri: string | null) => void) | null>(null);
  const att = useAttitude(true, 50);
  const { fix } = usePosition(true, true);

  useEffect(() => {
    getStation(sid).then(setStation);
    (async () => {
      const list = await listCaptures(sid);
      setCaps(list);
      const saved = await kvGet(`ghost:${sid}`);
      const ref = list.find((x) => x.is_reference) ?? list[0];
      const pick =
        saved === 'latest' ? list[list.length - 1] : list.find((x) => String(x.id) === saved) ?? ref;
      setGhostId(pick?.id ?? null);
    })();
    kvGet('saveToPhotos').then((v) => setSaveToPhotos(v !== '0'));
    kvGet('edgeColour').then((v) => v && setEdgeColour(Number(v) % EDGE_COLOURS.length));
    kvGet(`stamp:${sid}`).then((v) => {
      if (v) {
        try {
          setStamp({ ...DEFAULT_STAMP, ...JSON.parse(v) });
        } catch {}
      }
    });
  }, [sid]);

  const saveStamp = (s: StampSettings) => {
    setStamp(s);
    kvSet(`stamp:${sid}`, JSON.stringify(s));
    setEditingStamp(false);
  };

  /** Render the stamped photo off-screen and snapshot it; resolves null on failure/timeout. */
  const makeStampedCopy = (uri: string, w: number, h: number, lines: string[]) =>
    new Promise<string | null>((resolve) => {
      const t = setTimeout(() => {
        snapResolve.current = null;
        setSnapJob(null);
        resolve(null);
      }, 10000);
      snapResolve.current = (u) => {
        clearTimeout(t);
        resolve(u);
      };
      setSnapJob({ uri, w, h, lines });
    });

  const onSnapReady = async () => {
    const done = snapResolve.current;
    if (!done || !snapView.current) return;
    snapResolve.current = null;
    try {
      // give layout one frame to settle
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      done(await snapshotStamp(snapView));
    } catch (e) {
      console.warn('stamp snapshot failed', e);
      done(null);
    } finally {
      setSnapJob(null);
    }
  };

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (mode !== 'flicker') return;
    const t = setInterval(() => setFlickOn((v) => !v), 450);
    return () => clearInterval(t);
  }, [mode]);

  const ghost = caps.find((x) => x.id === ghostId) ?? null;
  const refCap = caps.find((x) => x.is_reference) ?? caps[0] ?? null;

  const chooseGhost = (cap: Capture | 'latest') => {
    const pick = cap === 'latest' ? caps[caps.length - 1] : cap;
    if (!pick) return;
    setGhostId(pick.id);
    kvSet(`ghost:${sid}`, cap === 'latest' ? 'latest' : String(pick.id));
    setPicking(false);
  };

  // Outline image of the ghost (computed once per photo, cached on disk).
  const needEdges = mode === 'edges' && !!ghost && edges?.id !== ghost.id;
  useEffect(() => {
    if (!needEdges || !ghost) return;
    let cancelled = false;
    edgesFor(ghost)
      .then((uri) => !cancelled && setEdges({ id: ghost.id, uri }))
      .catch(() => !cancelled && setEdges({ id: ghost.id, uri: null }));
    return () => {
      cancelled = true;
    };
  }, [needEdges, ghost]);

  // Small copy of the ghost for live matching.
  const ghostUri = ghost?.uri;
  useEffect(() => {
    if (!alignmentAvailable || !ghostUri || !ghost) return;
    let cancelled = false;
    let made: string | null = null;
    ghostForMatching(ghost)
      .then((u) => {
        made = u;
        if (!cancelled) setGhostSmall(u);
        else deleteFile(u);
      })
      .catch((e) => console.warn('ghost prep', e));
    return () => {
      cancelled = true;
      setGhostSmall(null);
      if (made) deleteFile(made);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghostUri]);

  // Live image matching: grab a silent low-quality frame, register it against the ghost, repeat.
  useEffect(() => {
    if (!liveOn || !ready || !ghostSmall) return;
    let stop = false;
    (async () => {
      while (!stop) {
        if (busyRef.current || !cam.current) {
          await sleep(300);
          continue;
        }
        const run = (async () => {
          const pic = await cam.current?.takePictureAsync({ quality: 0.3, shutterSound: false });
          if (!pic) return;
          try {
            if (stop) return;
            const { hfov, vfov } = fovRef.current;
            const m = await matchLiveFrame(ghostSmall, pic.uri, hfov, vfov);
            if (!stop) setLive(m);
          } finally {
            deleteFile(pic.uri);
          }
        })();
        liveInFlight.current = run;
        try {
          await run;
        } catch (e) {
          console.warn('live match', e);
          await sleep(1000);
        }
        liveInFlight.current = null;
        await sleep(200);
      }
    })();
    return () => {
      stop = true;
    };
  }, [liveOn, ready, ghostSmall]);

  // A live match goes stale after a few seconds without a fresh one.
  useEffect(() => {
    if (!live) return;
    const t = setTimeout(() => setLive(null), 3000);
    return () => clearTimeout(t);
  }, [live]);

  // ---- Geometry -------------------------------------------------------------------
  // The UI stays portrait. When the phone is turned sideways, everything that has to look
  // upright to the person holding it (ghost, grid, guide, readout) lives in a "physical
  // frame" rotated ±90°. The camera preview itself already looks upright, so it isn't rotated.
  const shot = shotOf(att.hold);
  const refShot =
    ghost?.orientation ??
    orientationOf(ghost?.width ?? null, ghost?.height ?? null) ??
    station?.orientation ??
    'portrait';
  const refAspect = // width / height as the ghost is viewed upright
    ghost?.width && ghost?.height ? ghost.width / ghost.height : refShot === 'landscape' ? 4 / 3 : 3 / 4;
  const sideways = shot === 'landscape';
  const screenAspect = sideways ? 1 / refAspect : refAspect; // the box as laid out on the portrait screen
  const maxH = winH * 0.62;
  let boxW = winW;
  let boxH = boxW / screenAspect;
  if (boxH > maxH) {
    boxH = maxH;
    boxW = boxH * screenAspect;
  }
  const physW = sideways ? boxH : boxW;
  const physH = sideways ? boxW : boxH;
  const physRotate = att.hold === 'cw' ? '90deg' : att.hold === 'ccw' ? '-90deg' : '0deg';
  const mismatch = !!ghost && refShot !== shot;
  useEffect(() => {
    fovRef.current = fovFor(refShot === 'landscape');
  }, [refShot]);

  // Aim for the attitude the ghost photo was taken at (falls back to the station's).
  const target: Target = {
    heading: ghost?.heading ?? station?.heading ?? null,
    pitch: ghost?.pitch ?? station?.pitch ?? null,
    roll: ghost?.roll ?? station?.roll ?? null,
  };
  const deltas = live?.ok ? imageDeltas(live.g) : sensorDeltas(att, target, sideways);
  const aligned = allAligned(deltas);
  useEffect(() => {
    if (aligned && !wasAligned.current) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    wasAligned.current = aligned;
  }, [aligned]);
  const dist = fix && station ? distanceM(fix, { latitude: station.lat, longitude: station.lon }) : null;

  const shoot = async () => {
    if (!cam.current || busy || !station) return;
    setBusy(true);
    busyRef.current = true;
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      if (liveInFlight.current) await liveInFlight.current.catch(() => {});
      setFlash(true);
      setTimeout(() => setFlash(false), 140);
      const takenAt = Date.now();
      const snap = { ...att };
      const snapShot = shotOf(snap.hold);
      const pos = fix;
      const extra: Record<string, unknown> = {
        UserComment: JSON.stringify({
          app: 'envrevisit',
          station: station.id,
          heading: snap.heading,
          pitch: snap.pitch,
          roll: snap.roll,
          orientation: snapShot,
        }),
      };
      if (pos) {
        extra.GPSLatitude = pos.latitude;
        extra.GPSLongitude = pos.longitude;
        if (pos.altitude != null) extra.GPSAltitude = pos.altitude;
      }
      if (snap.heading != null) {
        extra.GPSImgDirection = snap.heading;
        extra.GPSImgDirectionRef = 'T';
      }
      const pic = await cam.current.takePictureAsync({ quality: 0.92, exif: true, additionalExif: extra });
      if (!pic) throw new Error('No picture returned');

      // Report dimensions as the photo is viewed upright.
      let w = pic.width;
      let h = pic.height;
      if ((snapShot === 'landscape') !== w > h) [w, h] = [h, w];

      // The app keeps a clean original (for alignment / change detection); stamps are an overlay.
      const fileUri = await persistCapture(pic.uri, station.id, takenAt);
      const lines = stamp.enabled
        ? stampLines({ takenAt, note1: stamp.note1, note2: stamp.note2, showDate: stamp.showDate })
        : [];

      if (saveToPhotos) {
        if (!mediaPerm?.granted) await requestMediaPerm();
        // Photos gets the stamped copy when a stamp is on (like a field-stamp camera).
        const stamped = lines.length ? await makeStampedCopy(fileUri, w, h, lines) : null;
        await saveToPhotosLibrary(stamped ?? fileUri);
      }

      const newId = await addCapture({
        station_id: station.id,
        uri: fileUri,
        source: 'app',
        taken_at: takenAt,
        lat: pos?.latitude ?? null,
        lon: pos?.longitude ?? null,
        accuracy: pos?.accuracy ?? null,
        heading: snap.heading,
        pitch: snap.pitch,
        roll: snap.roll,
        width: w,
        height: h,
        orientation: snapShot,
        note1: stamp.enabled ? stamp.note1.trim() || null : null,
        note2: stamp.enabled ? stamp.note2.trim() || null : null,
        stamp_date: stamp.enabled && stamp.showDate ? 1 : 0,
        is_reference: 0,
      });

      // A camera-roll reference has no pitch/roll. The first in-app capture taken the same
      // way round fills them in, so every later visit gets full 3-axis guidance.
      const sameWay = (station.orientation ?? snapShot) === snapShot;
      if (sameWay && (station.pitch == null || station.roll == null || station.heading == null || !station.orientation)) {
        const patch = {
          heading: station.heading ?? snap.heading,
          pitch: station.pitch ?? snap.pitch,
          roll: station.roll ?? snap.roll,
          orientation: station.orientation ?? snapShot,
        };
        await updateStation(station.id, patch);
        setStation({ ...station, ...patch });
      }
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setLastSaved(fileUri);
      setLastId(newId);
      setCaps(await listCaptures(station.id));
      // Register to the reference in the background (EnvRevisit build only).
      if (alignmentAvailable) alignCapture(station.id, newId).catch((e) => console.warn('align', e));
    } catch (e) {
      console.warn(e);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };

  if (!camPerm) return <View style={{ flex: 1, backgroundColor: '#000' }} />;
  if (!camPerm.granted) {
    return (
      <View style={[styles.fill, styles.center, { backgroundColor: '#000', gap: 16 }]}>
        <Text style={{ color: '#fff', textAlign: 'center', paddingHorizontal: 30 }}>
          Camera access is needed to retake the photo.
        </Text>
        <Btn title="Allow camera" onPress={() => requestCamPerm()} />
        <Btn title="Cancel" kind="ghost" onPress={() => router.back()} />
      </View>
    );
  }

  const ghostOpacity =
    mode === 'off' ? 0 : mode === 'flicker' ? (flickOn ? 1 : 0) : mode === 'split' ? 1 : mode === 'edges' ? 0 : amount;
  const edgeUri = mode === 'edges' && edges && ghost && edges.id === ghost.id ? edges.uri : null;

  return (
    <View style={[styles.fill, { backgroundColor: '#000' }]}>
      <StatusBar hidden />
      <View style={[styles.topRow, { paddingTop: Math.max(insets.top, 12) }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Text style={styles.close}>✕</Text>
        </Pressable>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={styles.title} numberOfLines={1}>
            {station?.name ?? ''}
          </Text>
          <Text style={styles.sub}>
            {dist == null
              ? 'Waiting for GPS…'
              : `${formatDistance(dist)} from station${fix?.accuracy != null ? ` · ±${fix.accuracy.toFixed(0)} m` : ''}`}
          </Text>
        </View>
        <Pressable onPress={() => setGrid((g) => !g)} hitSlop={12}>
          <Text style={[styles.close, { fontSize: 16, opacity: grid ? 1 : 0.5 }]}>#</Text>
        </Pressable>
      </View>

      <View style={[styles.center, { flex: 1 }]}>
        <View style={{ width: boxW, height: boxH, overflow: 'hidden' }}>
          <CameraView
            ref={cam}
            style={StyleSheet.absoluteFill}
            facing="back"
            animateShutter={false}
            responsiveOrientationWhenOrientationLocked
            onCameraReady={() => setReady(true)}
          />

          {/* Physical frame: rotated so overlays look upright however the phone is held. */}
          <View
            pointerEvents="none"
            style={{
              position: 'absolute',
              width: physW,
              height: physH,
              left: (boxW - physW) / 2,
              top: (boxH - physH) / 2,
              transform: [{ rotate: physRotate }],
            }}>
            {ghost && ghostOpacity > 0 && (
              <View
                style={[
                  StyleSheet.absoluteFill,
                  mode === 'split' && { right: undefined, width: physW * amount, overflow: 'hidden' },
                ]}>
                <Image
                  source={{ uri: ghost.uri }}
                  style={{ width: physW, height: physH, opacity: ghostOpacity }}
                  contentFit="cover"
                />
              </View>
            )}
            {edgeUri && (
              <Image
                source={{ uri: edgeUri }}
                style={[StyleSheet.absoluteFill, { opacity: 0.35 + 0.65 * amount }]}
                contentFit="cover"
                tintColor={EDGE_COLOURS[edgeColour]}
              />
            )}
            {mode === 'edges' && !edgeUri && (
              <View style={styles.notice}>
                <Text style={styles.noticeText}>
                  {!alignmentAvailable
                    ? 'Edges need the EnvRevisit build'
                    : edges && ghost && edges.id === ghost.id
                      ? 'Could not make edges for this photo'
                      : 'Preparing edges…'}
                </Text>
              </View>
            )}
            {mode === 'split' && <View style={[styles.divider, { left: physW * amount - 1 }]} />}

            {grid && (
              <View style={StyleSheet.absoluteFill}>
                {[1, 2].map((i) => (
                  <View key={`v${i}`} style={[styles.gridV, { left: (physW * i) / 3 }]} />
                ))}
                {[1, 2].map((i) => (
                  <View key={`h${i}`} style={[styles.gridH, { top: (physH * i) / 3 }]} />
                ))}
              </View>
            )}

            <AlignmentGuide width={physW} height={physH} d={deltas} />
            <GuideHud d={deltas} />
            {stamp.enabled && (
              <StampOverlay
                lines={stampLines({ takenAt: now, note1: stamp.note1, note2: stamp.note2, showDate: stamp.showDate })}
                frameWidth={physW}
              />
            )}
            <StakeoutChip
              fix={fix}
              target={station ? { latitude: station.lat, longitude: station.lon } : null}
              heading={att.heading}
            />

            {mismatch && (
              <View style={styles.mismatch}>
                <Text style={styles.mismatchText}>
                  {refShot === 'landscape'
                    ? 'Original is landscape — turn the phone sideways'
                    : 'Original is portrait — turn the phone upright'}
                </Text>
              </View>
            )}
          </View>

          {flash && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(255,255,255,0.7)' }]} />}
          {!ready && (
            <View style={[StyleSheet.absoluteFill, styles.center]}>
              <ActivityIndicator color="#fff" />
            </View>
          )}
        </View>
      </View>

      <View style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
        <View style={styles.modes}>
          <Pill
            label={`Ghost: ${ghost ? (ghost.id === refCap?.id ? 'Original' : fmtDate(ghost.taken_at)) : '—'} ▾`}
            active
            onPress={() => setPicking(true)}
          />
          {alignmentAvailable && (
            <Pill label={liveOn ? '📷 Live match on' : '📷 Live match off'} active={liveOn} onPress={() => setLiveOn((v) => !v)} />
          )}
          <Pill label={stamp.enabled ? '✎ Stamp on' : '✎ Stamp'} active={stamp.enabled} onPress={() => setEditingStamp(true)} />
        </View>
        <View style={styles.modes}>
          {MODES.map((m) => (
            <Pill key={m} label={m[0].toUpperCase() + m.slice(1)} active={mode === m} onPress={() => setMode(m)} />
          ))}
          {mode === 'edges' && (
            <Pressable
              onPress={() => {
                const n = (edgeColour + 1) % EDGE_COLOURS.length;
                setEdgeColour(n);
                kvSet('edgeColour', String(n));
              }}
              style={[styles.swatch, { backgroundColor: EDGE_COLOURS[edgeColour] }]}
            />
          )}
        </View>
        {(mode === 'blend' || mode === 'split' || mode === 'edges') && (
          <View style={{ paddingHorizontal: 24 }}>
            <Slider value={amount} onChange={setAmount} fillColor={c.accent} />
          </View>
        )}
        <View style={styles.shutterRow}>
          <Pressable
            style={{ width: 64 }}
            onPress={() => {
              const v = !saveToPhotos;
              setSaveToPhotos(v);
              kvSet('saveToPhotos', v ? '1' : '0');
            }}>
            <Text style={styles.small}>{saveToPhotos ? 'Also saving\nto Photos' : 'App only'}</Text>
          </Pressable>
          <Pressable
            onPress={shoot}
            disabled={!ready || busy}
            style={[styles.shutter, (!ready || busy) && { opacity: 0.5 }]}>
            <View style={styles.shutterInner} />
          </Pressable>
          <Pressable
            style={{ width: 64, alignItems: 'flex-end' }}
            onPress={() =>
              lastId
                ? router.push({
                    pathname: '/timeline/[id]',
                    params: { id: String(sid), a: String(ghost?.id ?? refCap?.id ?? ''), b: String(lastId), view: 'compare' },
                  })
                : router.push(`/timeline/${sid}`)
            }>
            {lastSaved ? (
              <Image source={{ uri: lastSaved }} style={styles.lastThumb} contentFit="cover" />
            ) : (
              <Text style={styles.small}>Timeline</Text>
            )}
          </Pressable>
        </View>
      </View>

      {snapJob && (
        <StampSnapshot
          viewRef={snapView}
          uri={snapJob.uri}
          widthPt={snapJob.w / PixelRatio.get()}
          heightPt={snapJob.h / PixelRatio.get()}
          lines={snapJob.lines}
          onReady={onSnapReady}
        />
      )}
      <Modal visible={picking} transparent animationType="slide" onRequestClose={() => setPicking(false)}>
        <Pressable style={{ flex: 1 }} onPress={() => setPicking(false)} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <Text style={styles.sheetTitle}>Line up with which photo?</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {refCap && <Pill label="Original" active={ghost?.id === refCap.id} onPress={() => chooseGhost(refCap)} />}
            {caps.length > 1 && (
              <Pill label="Latest" active={ghost?.id === caps[caps.length - 1].id} onPress={() => chooseGhost('latest')} />
            )}
          </View>
          <FlatList
            horizontal
            data={caps}
            keyExtractor={(x) => String(x.id)}
            contentContainerStyle={{ gap: 10 }}
            showsHorizontalScrollIndicator={false}
            renderItem={({ item }) => (
              <Pressable onPress={() => chooseGhost(item)} style={{ width: 96 }}>
                <Image
                  source={{ uri: item.uri }}
                  style={[styles.pickThumb, item.id === ghost?.id && { borderColor: c.accent }]}
                  contentFit="cover"
                />
                <Text style={styles.pickLabel} numberOfLines={1}>
                  {item.id === refCap?.id ? 'Original' : fmtDate(item.taken_at)}
                </Text>
                {item.id === refCap?.id && <Text style={styles.pickSub}>{fmtDate(item.taken_at)}</Text>}
              </Pressable>
            )}
          />
          <Text style={styles.pickHint}>
            Remembered for this station. Alignment in the timeline always uses the station&apos;s reference photo.
          </Text>
        </View>
      </Modal>
      {editingStamp && (
        <StampEditor visible initial={stamp} onClose={() => setEditingStamp(false)} onSave={saveStamp} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  topRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 6, gap: 10 },
  close: { color: '#fff', fontSize: 22, fontWeight: '600', width: 28, textAlign: 'center' },
  title: { color: '#fff', fontWeight: '700', fontSize: 15 },
  sub: { color: 'rgba(255,255,255,0.7)', fontSize: 12 },
  modes: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', flexWrap: 'wrap', gap: 6, paddingTop: 8 },
  shutterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 28,
    paddingVertical: 10,
  },
  shutter: {
    width: 74,
    height: 74,
    borderRadius: 37,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  shutterInner: { width: 58, height: 58, borderRadius: 29, backgroundColor: '#fff' },
  small: { color: '#fff', fontSize: 11, textAlign: 'center' },
  lastThumb: { width: 48, height: 48, borderRadius: 8, borderWidth: 2, borderColor: '#fff' },
  divider: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: '#fff' },
  gridV: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.45)',
  },
  gridH: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: 'rgba(255,255,255,0.45)',
  },
  swatch: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: '#fff' },
  notice: {
    position: 'absolute',
    alignSelf: 'center',
    top: '45%',
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  noticeText: { color: '#fff', fontWeight: '700' },
  sheet: {
    backgroundColor: '#111',
    padding: 16,
    gap: 12,
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
  },
  sheetTitle: { color: '#fff', fontSize: 17, fontWeight: '800' },
  pickThumb: { width: 96, height: 96, borderRadius: 10, borderWidth: 3, borderColor: 'transparent' },
  pickLabel: { color: '#fff', fontSize: 12, fontWeight: '700', marginTop: 4 },
  pickSub: { color: 'rgba(255,255,255,0.6)', fontSize: 11 },
  pickHint: { color: 'rgba(255,255,255,0.6)', fontSize: 12 },
  mismatch: {
    position: 'absolute',
    top: '40%',
    left: 10,
    right: 10,
    padding: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(194,65,12,0.85)',
  },
  mismatchText: { color: '#fff', fontWeight: '700', textAlign: 'center', fontSize: 13 },
});
