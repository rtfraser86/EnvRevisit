import { CameraView, useCameraPermissions, type LensInfo } from 'expo-camera';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import { usePermissions as useMediaPermissions } from 'expo-media-library';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { MarkerOverlay } from '@/components/markers';
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
  deleteStation,
  getStation,
  kvGet,
  kvSet,
  listCaptures,
  parseMarkers,
  updateStation,
  type Capture,
  type LensKind,
  type Station,
} from '@/lib/db';
import {
  alignCapture,
  alignmentAvailable,
  deleteFile,
  edgesFor,
  ghostForMatching,
  matchLiveFrame,
  matchVideoFrame,
  smoothMatch,
  stopVideoMatching,
  videoMatchAvailable,
  cameraZoomRange,
  zoomPropFor,
  type LiveMatch,
} from '@/lib/align';
import { orientationOf, readPose } from '@/lib/library';
import { shotOf, useAttitude, usePosition } from '@/lib/sensors';
import { stepHint, smoothStep, stepText, type StepHint } from '@/lib/step-hint';
import { persistCapture, saveToPhotosLibrary } from '@/lib/storage';

type Mode = 'blend' | 'edges' | 'split' | 'flicker' | 'off';
const MODES: Mode[] = ['blend', 'edges', 'split', 'flicker', 'off'];
const EDGE_COLOURS = ['#22D3EE', '#F472B6', '#FACC15', '#FFFFFF'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LENS: Record<LensKind, { label: string; f35: number }> = {
  ultrawide: { label: '0.5×', f35: 13 },
  wide: { label: '1×', f35: 26 },
  tele: { label: 'Tele', f35: 77 },
};
const LENS_ORDER: LensKind[] = ['ultrawide', 'wide', 'tele'];
function lensKind(deviceType: string): LensKind | null {
  if (deviceType.includes('UltraWide')) return 'ultrawide';
  if (deviceType.includes('Telephoto')) return 'tele';
  if (deviceType.includes('WideAngle')) return 'wide';
  return null; // virtual multi-lens devices
}
const kindFromFocal = (f35: number): LensKind => (f35 < 19 ? 'ultrawide' : f35 > 40 ? 'tele' : 'wide');

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
  const [lenses, setLenses] = useState<Partial<Record<LensKind, string>>>({});
  const [lens, setLens] = useState<LensKind>('wide');
  const [extra, setExtra] = useState(1); // in-between zoom on top of the lens (1 = none)
  const [zoomRange, setZoomRange] = useState<{ min: number; max: number } | null>(null);
  const [focused, setFocused] = useState(true);
  const [videoMode, setVideoMode] = useState(false);
  const holdRef = useRef<'portrait' | 'cw' | 'ccw'>('portrait');
  const pitchRef = useRef<number | null>(null);
  const [step, setStep] = useState<StepHint | null>(null);
  const lensPicked = useRef(false); // true once the user chooses a lens by hand
  const att = useAttitude(true, 50);
  const { fix } = usePosition(true, true);
  useKeepAwake(); // don't let the screen sleep while lining up

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
    kvGet('ghostMode').then((v) => v && (MODES as string[]).includes(v) && setMode(v as Mode));
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
  const markers = parseMarkers(ghost);

  // Coming back from the marker editor or the timeline: pick up any changes.
  // The camera and live matching pause while another screen is on top.
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      listCaptures(sid).then(setCaps);
      return () => setFocused(false);
    }, [sid])
  );

  const pickMode = (m: Mode) => {
    setMode(m);
    kvSet('ghostMode', m);
  };

  // Match the lens to the ghost photo (unless a lens was chosen by hand for this session).
  const ghostLens = ghost?.lens ?? null;
  const ghostZoom = ghost?.zoom ?? null;
  const ghostLibraryUri = ghost?.source === 'library' ? ghost.uri : null;
  useEffect(() => {
    if (lensPicked.current || !ghostId) return;
    let cancelled = false;
    (async () => {
      // The ghost's 35 mm-equivalent focal length, if known.
      let ghostF: number | null = ghostLens ? LENS[ghostLens].f35 * (ghostZoom ?? 1) : null;
      if (ghostF == null && ghostLibraryUri) {
        const pose = await readPose(ghostLibraryUri);
        ghostF = pose.focalLength35 ?? null;
      }
      if (cancelled || ghostF == null) return;
      // Longest lens that isn't longer than the ghost's, then zoom in the rest of the way.
      const have = LENS_ORDER.filter((k) => k === 'wide' || lenses[k]);
      const fits = have.filter((k) => LENS[k].f35 <= ghostF * 1.08);
      const want = fits.length ? fits[fits.length - 1] : kindFromFocal(ghostF);
      if (!have.includes(want)) return;
      setLens(want);
      const rest = ghostF / LENS[want].f35;
      setExtra(rest > 1.08 ? Math.min(10, rest) : 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [ghostId, ghostLens, ghostZoom, ghostLibraryUri, lenses]);

  // How far the current camera can zoom (needed to set in-between zoom levels exactly).
  useEffect(() => {
    if (!ready || !focused) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      const r = await cameraZoomRange();
      if (!cancelled) setZoomRange(r);
    }, 700);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [ready, focused, lens]);

  const applyLenses = (list: LensInfo[] | undefined) => {
    const found: Partial<Record<LensKind, string>> = {};
    for (const l of list ?? []) {
      const k = lensKind(l.deviceType);
      if (k && !found[k]) found[k] = l.deviceType;
    }
    if (Object.keys(found).length) setLenses(found);
  };

  const close = async () => {
    // A brand-new station with no photo taken is just clutter: remove it.
    if (caps.length === 0) await deleteStation(sid).catch(() => {});
    router.back();
  };

  const chooseGhost = (cap: Capture | 'latest') => {
    const pick = cap === 'latest' ? caps[caps.length - 1] : cap;
    if (!pick) return;
    setGhostId(pick.id);
    setStep(null);
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

  // Live image matching. Preferred: the native side registers the camera's own video frames
  // against the ghost several times a second. Fallback (older build, or it can't attach to the
  // camera): grab a silent low-quality still about once a second and register that.
  useEffect(() => {
    if (!liveOn || !ready || !ghostSmall || !focused) return;
    let stop = false;
    let useVideo = videoMatchAvailable;
    let noCamera = 0;
    (async () => {
      while (!stop) {
        if (busyRef.current || !cam.current) {
          await sleep(300);
          continue;
        }
        const { hfov, vfov } = fovRef.current;
        if (useVideo) {
          try {
            const m = await matchVideoFrame(ghostSmall, holdRef.current, hfov, vfov);
            if (stop) break;
            if (!m.ok && m.reason === 'no-camera') {
              // Give the camera a few seconds to start before giving up on video frames.
              if (++noCamera >= 12) useVideo = false;
              await sleep(300);
              continue;
            }
            noCamera = 0;
            setVideoMode(true);
            setLive((prev) => smoothMatch(prev, m));
            if (m.ok) {
              const s = stepHint(m.bands, pitchRef.current, hfov, vfov);
              setStep((prev) => (s ? smoothStep(prev, s) : prev));
            }
          } catch (e) {
            console.warn('video match', e);
            useVideo = false;
          }
          await sleep(120);
          continue;
        }
        setVideoMode(false);
        const run = (async () => {
          const pic = await cam.current?.takePictureAsync({ quality: 0.3, shutterSound: false });
          if (!pic) return;
          try {
            if (stop) return;
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
  }, [liveOn, ready, ghostSmall, focused]);

  // Hand the camera's video frames back when live matching isn't in use.
  useEffect(() => {
    if (liveOn && focused) return;
    stopVideoMatching();
  }, [liveOn, focused]);
  useEffect(() => stopVideoMatching, []);

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
  const hold = att.hold;
  const pitchNow = att.pitch;
  useEffect(() => {
    holdRef.current = hold;
  }, [hold]);
  useEffect(() => {
    pitchRef.current = pitchNow;
  }, [pitchNow]);
  // With no ghost yet (first photo of a new station) the frame follows how the phone is held.
  const refShot = ghost
    ? ghost.orientation ?? orientationOf(ghost.width, ghost.height) ?? station?.orientation ?? 'portrait'
    : shot;
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
  const applied = zoomRange ? extra : 1;
  const f35 = LENS[lens].f35 * applied;
  useEffect(() => {
    fovRef.current = fovFor(refShot === 'landscape', f35);
  }, [refShot, f35]);

  // Aim for the attitude the ghost photo was taken at (falls back to the station's).
  const target: Target = {
    heading: ghost?.heading ?? station?.heading ?? null,
    pitch: ghost?.pitch ?? station?.pitch ?? null,
    roll: ghost?.roll ?? station?.roll ?? null,
  };
  const deltas = live?.ok ? imageDeltas(live.g) : sensorDeltas(att, target, sideways, f35);
  const aligned = allAligned(deltas);
  useEffect(() => {
    if (aligned && !wasAligned.current) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    wasAligned.current = aligned;
  }, [aligned]);

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
      const first = caps.length === 0;
      let st = station;
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
        lens,
        zoom: applied > 1.001 ? applied : null,
        is_reference: first ? 1 : 0,
      });
      if (first) {
        // New station: the first photo defines where to stand as well as the view.
        if (pos) {
          const place = { lat: pos.latitude, lon: pos.longitude };
          await updateStation(station.id, place);
          st = { ...st, ...place };
          setStation(st);
        }
        setGhostId(newId);
      }

      // A camera-roll reference has no pitch/roll. The first in-app capture taken the same
      // way round fills them in, so every later visit gets full 3-axis guidance.
      const sameWay = (st.orientation ?? snapShot) === snapShot;
      if (sameWay && (st.pitch == null || st.roll == null || st.heading == null || !st.orientation)) {
        const patch = {
          heading: st.heading ?? snap.heading,
          pitch: st.pitch ?? snap.pitch,
          roll: st.roll ?? snap.roll,
          orientation: st.orientation ?? snapShot,
        };
        await updateStation(st.id, patch);
        setStation({ ...st, ...patch });
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
      Alert.alert('Photo not saved', String(e instanceof Error ? e.message : e));
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
        <Pressable onPress={close} hitSlop={12}>
          <Text style={styles.close}>✕</Text>
        </Pressable>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={styles.title} numberOfLines={1}>
            {station?.name ?? ''}
          </Text>
          {ghost ? (
            <Pressable onPress={() => setPicking(true)} hitSlop={8} style={styles.ghostPick}>
              <Text style={styles.ghostPickText} numberOfLines={1}>
                Lining up with: {ghost.id === refCap?.id ? `Original (${fmtDate(ghost.taken_at)})` : fmtDate(ghost.taken_at)} ▾
              </Text>
            </Pressable>
          ) : (
            <Text style={styles.sub}>New station</Text>
          )}
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
            active={focused}
            animateShutter={false}
            selectedLens={lens === 'wide' ? undefined : lenses[lens]}
            zoom={zoomPropFor(extra, zoomRange)}
            onAvailableLensesChanged={(e: { lenses: LensInfo[] }) => applyLenses(e.lenses)}
            responsiveOrientationWhenOrientationLocked
            onCameraReady={() => {
              setReady(true);
              // The lens list event isn't guaranteed to fire on mount, so ask as well.
              cam.current?.getAvailableLensesAsync?.().then(applyLenses).catch(() => {});
            }}
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

            <MarkerOverlay markers={markers} width={physW} height={physH} />
            {!ghost && (
              <View style={styles.notice}>
                <Text style={styles.noticeText}>First photo — this becomes the reference</Text>
              </View>
            )}
            {ghost && <AlignmentGuide width={physW} height={physH} d={deltas} />}
            {ghost && <GuideHud d={deltas} video={videoMode} step={live?.ok && videoMode ? stepText(step) : null} />}
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

          {(LENS_ORDER.filter((k) => lenses[k]).length > 1 || !!zoomRange) && (
            <View style={styles.lensRow} pointerEvents="box-none">
              {!!zoomRange && (
                <Pressable
                  hitSlop={6}
                  onPress={() => {
                    lensPicked.current = true;
                    setExtra((v) => Math.max(1, +(v / 1.1).toFixed(3)));
                    setLive(null);
                    setStep(null);
                  }}
                  style={styles.lensBtn}>
                  <Text style={styles.lensText}>−</Text>
                </Pressable>
              )}
              {LENS_ORDER.filter((k) => lenses[k] || k === lens).map((k) => (
                <Pressable
                  key={k}
                  hitSlop={6}
                  onPress={() => {
                    lensPicked.current = true;
                    setLens(k);
                    setExtra(1);
                    setLive(null);
                    setStep(null);
                  }}
                  style={[styles.lensBtn, lens === k && { backgroundColor: '#FACC15' }]}>
                  <Text style={[styles.lensText, lens === k && { color: '#000' }]}>
                    {lens === k && applied > 1.001 ? `${((LENS[k].f35 * applied) / 26).toFixed(1)}×` : LENS[k].label}
                  </Text>
                </Pressable>
              ))}
              {!!zoomRange && (
                <Pressable
                  hitSlop={6}
                  onPress={() => {
                    lensPicked.current = true;
                    setExtra((v) => Math.min(10, +(v * 1.1).toFixed(3)));
                    setLive(null);
                    setStep(null);
                  }}
                  style={styles.lensBtn}>
                  <Text style={styles.lensText}>+</Text>
                </Pressable>
              )}
            </View>
          )}
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
          {alignmentAvailable && ghost && (
            <Pill label="📷 Live match" active={liveOn} onPress={() => setLiveOn((v) => !v)} />
          )}
          {ghost && (
            <Pill
              label={markers.length ? `⌖ Markers (${markers.length})` : '⌖ Markers'}
              active={markers.length > 0}
              onPress={() => router.push(`/markers/${ghost.id}`)}
            />
          )}
          <Pill label={stamp.enabled ? '✎ Stamp on' : '✎ Stamp'} active={stamp.enabled} onPress={() => setEditingStamp(true)} />
        </View>
        <View style={styles.modes}>
          {ghost &&
            MODES.map((m) => (
              <Pill key={m} label={m[0].toUpperCase() + m.slice(1)} active={mode === m} onPress={() => pickMode(m)} />
            ))}
          {ghost && mode === 'edges' && (
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
        {ghost && (mode === 'blend' || mode === 'split' || mode === 'edges') && (
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
              <View style={{ alignItems: 'center' }}>
                <Image source={{ uri: lastSaved }} style={styles.lastThumb} contentFit="cover" />
                <Text style={[styles.small, { fontWeight: '800', marginTop: 2 }]}>Check ›</Text>
              </View>
            ) : caps.length ? (
              <Text style={styles.small}>Timeline</Text>
            ) : null}
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
  ghostPick: {
    marginTop: 2,
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  ghostPickText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  lensRow: {
    position: 'absolute',
    bottom: 8,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  lensBtn: {
    minWidth: 38,
    height: 30,
    paddingHorizontal: 8,
    borderRadius: 15,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  lensText: { color: '#fff', fontWeight: '800', fontSize: 12 },
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
