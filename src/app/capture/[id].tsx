import { CameraView, useCameraPermissions } from 'expo-camera';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { usePermissions as useMediaPermissions } from 'expo-media-library';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AlignmentGuide, GuideReadout, type Target } from '@/components/alignment-guide';
import { Slider } from '@/components/slider';
import { Btn, Pill, useColors } from '@/components/ui';
import { addCapture, getReference, getStation, kvGet, kvSet, updateStation, type Capture, type Station } from '@/lib/db';
import { distanceM, formatDistance } from '@/lib/geo';
import { orientationOf } from '@/lib/library';
import { shotOf, useAttitude, usePosition } from '@/lib/sensors';
import { persistCapture } from '@/lib/storage';

type Mode = 'blend' | 'split' | 'flicker' | 'off';

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
  const [ref, setRef] = useState<Capture | null>(null);
  const [mode, setMode] = useState<Mode>('blend');
  const [amount, setAmount] = useState(0.5); // opacity for blend, divider for split
  const [flickOn, setFlickOn] = useState(true);
  const [grid, setGrid] = useState(true);
  const [saveToPhotos, setSaveToPhotos] = useState(true);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const att = useAttitude(true, 50);
  const { fix } = usePosition(true, true);

  useEffect(() => {
    getStation(sid).then(setStation);
    getReference(sid).then(setRef);
    kvGet('saveToPhotos').then((v) => setSaveToPhotos(v !== '0'));
  }, [sid]);

  useEffect(() => {
    if (mode !== 'flicker') return;
    const t = setInterval(() => setFlickOn((v) => !v), 450);
    return () => clearInterval(t);
  }, [mode]);

  // ---- Geometry -------------------------------------------------------------------
  // The UI stays portrait. When the phone is turned sideways, everything that has to look
  // upright to the person holding it (ghost, grid, guide, readout) lives in a "physical
  // frame" rotated ±90°. The camera preview itself already looks upright, so it isn't rotated.
  const shot = shotOf(att.hold);
  const refShot =
    station?.orientation ?? ref?.orientation ?? orientationOf(ref?.width ?? null, ref?.height ?? null) ?? 'portrait';
  const refAspect = // width / height as the reference is viewed upright
    ref?.width && ref?.height ? ref.width / ref.height : refShot === 'landscape' ? 4 / 3 : 3 / 4;
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
  const physRotate = att.hold === 'cw' ? '-90deg' : att.hold === 'ccw' ? '90deg' : '0deg';
  const mismatch = !!ref && refShot !== shot;

  const target: Target = {
    heading: station?.heading ?? null,
    pitch: station?.pitch ?? null,
    roll: station?.roll ?? null,
  };
  const dist = fix && station ? distanceM(fix, { latitude: station.lat, longitude: station.lon }) : null;

  const shoot = async () => {
    if (!cam.current || busy || !station) return;
    setBusy(true);
    try {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
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

      if (saveToPhotos && !mediaPerm?.granted) await requestMediaPerm();
      const { fileUri } = await persistCapture(pic.uri, station.id, takenAt, saveToPhotos);

      await addCapture({
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
    } catch (e) {
      console.warn(e);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setBusy(false);
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

  const ghostOpacity = mode === 'off' ? 0 : mode === 'flicker' ? (flickOn ? 1 : 0) : mode === 'split' ? 1 : amount;

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
            animateShutter
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
            {ref && ghostOpacity > 0 && (
              <View
                style={[
                  StyleSheet.absoluteFill,
                  mode === 'split' && { right: undefined, width: physW * amount, overflow: 'hidden' },
                ]}>
                <Image
                  source={{ uri: ref.uri }}
                  style={{ width: physW, height: physH, opacity: ghostOpacity }}
                  contentFit="cover"
                />
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

            <AlignmentGuide width={physW} height={physH} att={att} target={target} />
            <GuideReadout att={att} target={target} />

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

          {!ready && (
            <View style={[StyleSheet.absoluteFill, styles.center]}>
              <ActivityIndicator color="#fff" />
            </View>
          )}
        </View>
      </View>

      <View style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
        <View style={styles.modes}>
          {(['blend', 'split', 'flicker', 'off'] as Mode[]).map((m) => (
            <Pill key={m} label={m[0].toUpperCase() + m.slice(1)} active={mode === m} onPress={() => setMode(m)} />
          ))}
        </View>
        {(mode === 'blend' || mode === 'split') && (
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
          <Pressable style={{ width: 64, alignItems: 'flex-end' }} onPress={() => router.replace(`/timeline/${sid}`)}>
            {lastSaved ? (
              <Image source={{ uri: lastSaved }} style={styles.lastThumb} contentFit="cover" />
            ) : (
              <Text style={styles.small}>Timeline</Text>
            )}
          </Pressable>
        </View>
      </View>
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
  modes: { flexDirection: 'row', justifyContent: 'center', gap: 8, paddingTop: 10 },
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
  mismatch: {
    position: 'absolute',
    bottom: 10,
    left: 10,
    right: 10,
    padding: 8,
    borderRadius: 8,
    backgroundColor: 'rgba(194,65,12,0.85)',
  },
  mismatchText: { color: '#fff', fontWeight: '700', textAlign: 'center', fontSize: 13 },
});
