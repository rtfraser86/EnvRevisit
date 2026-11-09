import { Image } from 'expo-image';
import { useState, type ComponentRef, type RefObject } from 'react';
import { Modal, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { captureRef } from 'react-native-view-shot';

import { Btn, useColors } from '@/components/ui';

export type StampSettings = {
  enabled: boolean;
  note1: string;
  note2: string;
  showDate: boolean;
};

export const DEFAULT_STAMP: StampSettings = { enabled: false, note1: '', note2: '', showDate: true };

export const stampDateText = (ms: number) =>
  new Date(ms).toLocaleString('en-AU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

/** The lines that make up a stamp, top to bottom. Empty → nothing to draw. */
export function stampLines(opts: { takenAt: number; note1?: string | null; note2?: string | null; showDate?: boolean }) {
  const lines: string[] = [];
  if (opts.showDate) lines.push(stampDateText(opts.takenAt));
  if (opts.note1?.trim()) lines.push(opts.note1.trim());
  if (opts.note2?.trim()) lines.push(opts.note2.trim());
  return lines;
}

/**
 * Text stamp drawn over a photo of the given (displayed) width. Bottom-right, scaled to
 * the frame so it looks the same on a thumbnail, the timeline and a full-res stamped copy.
 */
export function StampOverlay({ lines, frameWidth }: { lines: string[]; frameWidth: number }) {
  if (!lines.length) return null;
  const fs = Math.max(8, frameWidth * 0.034);
  return (
    <View pointerEvents="none" style={[styles.wrap, { right: fs * 0.6, bottom: fs * 0.6, padding: fs * 0.35, borderRadius: fs * 0.3 }]}>
      {lines.map((l, i) => (
        <Text
          key={i}
          numberOfLines={1}
          style={[styles.text, { fontSize: fs, lineHeight: fs * 1.25, fontWeight: i === 0 ? '700' : '600' }]}>
          {l}
        </Text>
      ))}
    </View>
  );
}

/**
 * Off-screen renderer used to make a stamped copy for the Photos library.
 * Lays the image out at its native pixel size (in points = px / pixelRatio) and snapshots it.
 */
export type SnapViewRef = RefObject<ComponentRef<typeof View> | null>;

export function StampSnapshot({
  viewRef,
  uri,
  widthPt,
  heightPt,
  lines,
  onReady,
}: {
  viewRef: SnapViewRef;
  uri: string;
  widthPt: number;
  heightPt: number;
  lines: string[];
  onReady: () => void;
}) {
  return (
    <View
      ref={viewRef}
      collapsable={false}
      pointerEvents="none"
      style={{ position: 'absolute', left: 0, top: 0, width: widthPt, height: heightPt, zIndex: -1 }}>
      <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" onLoad={onReady} transition={0} />
      <StampOverlay lines={lines} frameWidth={widthPt} />
    </View>
  );
}

export async function snapshotStamp(viewRef: SnapViewRef): Promise<string> {
  // react-native-view-shot accepts a ref object directly
  return captureRef(viewRef as Parameters<typeof captureRef>[0], { format: 'jpg', quality: 0.92, result: 'tmpfile' });
}

/** Editor for the two note lines + date toggle. Used before shooting and to edit an existing photo. */
export function StampEditor({
  visible,
  initial,
  title = 'Photo stamp',
  showEnable = true,
  onClose,
  onSave,
}: {
  visible: boolean;
  initial: StampSettings;
  title?: string;
  showEnable?: boolean;
  onClose: () => void;
  onSave: (s: StampSettings) => void;
}) {
  const c = useColors();
  // Mount this only while open (e.g. `{open && <StampEditor …/>}`) so it starts from `initial`.
  const [s, setS] = useState(initial);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: c.card }]}>
        <Text style={{ color: c.text, fontSize: 18, fontWeight: '700' }}>{title}</Text>
        {showEnable && (
          <View style={styles.switchRow}>
            <Text style={{ color: c.text, fontSize: 16 }}>Stamp this photo</Text>
            <Switch value={s.enabled} onValueChange={(v) => setS({ ...s, enabled: v })} />
          </View>
        )}
        <TextInput
          value={s.note1}
          onChangeText={(t) => setS({ ...s, note1: t })}
          placeholder="Line 1 (e.g. Site 4 — gully head)"
          placeholderTextColor={c.muted}
          maxLength={70}
          style={[styles.input, { color: c.text, borderColor: c.line, backgroundColor: c.bg }]}
        />
        <TextInput
          value={s.note2}
          onChangeText={(t) => setS({ ...s, note2: t })}
          placeholder="Line 2 (e.g. post-wet, lantana regrowth)"
          placeholderTextColor={c.muted}
          maxLength={70}
          style={[styles.input, { color: c.text, borderColor: c.line, backgroundColor: c.bg }]}
        />
        <View style={styles.switchRow}>
          <Text style={{ color: c.text, fontSize: 16 }}>Show date & time</Text>
          <Switch value={s.showDate} onValueChange={(v) => setS({ ...s, showDate: v })} />
        </View>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
          <Btn title="Cancel" kind="secondary" style={{ flex: 1 }} onPress={onClose} />
          <Btn title="Save" style={{ flex: 1 }} onPress={() => onSave(s)} />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'flex-end', maxWidth: '90%' },
  text: {
    color: '#fff',
    textShadowColor: 'rgba(0,0,0,0.9)',
    textShadowRadius: 3,
    textShadowOffset: { width: 0, height: 1 },
  },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  sheet: { padding: 18, paddingBottom: 36, gap: 12, borderTopLeftRadius: 18, borderTopRightRadius: 18 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, height: 46, fontSize: 16 },
});
