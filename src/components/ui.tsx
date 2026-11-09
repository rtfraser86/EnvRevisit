import { Pressable, StyleSheet, Text, View, useColorScheme, type ViewStyle } from 'react-native';

export const palette = {
  light: {
    bg: '#F5F6F2',
    card: '#FFFFFF',
    line: '#DADDD5',
    text: '#15191A',
    muted: '#5C6560',
    accent: '#1F7A5A', // eucalypt green
    accentText: '#FFFFFF',
    warn: '#C2410C',
    good: '#15803D',
  },
  dark: {
    bg: '#0E1211',
    card: '#181D1C',
    line: '#2A3230',
    text: '#EEF2EF',
    muted: '#9AA5A0',
    accent: '#3FB68B',
    accentText: '#06120D',
    warn: '#FB923C',
    good: '#4ADE80',
  },
};

export type Palette = (typeof palette)['light'];

export function useColors(): Palette {
  return useColorScheme() === 'dark' ? palette.dark : palette.light;
}

export function Btn({
  title,
  onPress,
  kind = 'primary',
  disabled,
  style,
  small,
}: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  style?: ViewStyle;
  small?: boolean;
}) {
  const c = useColors();
  const bg =
    kind === 'primary' ? c.accent : kind === 'danger' ? c.warn : kind === 'ghost' ? 'transparent' : c.card;
  const fg = kind === 'primary' ? c.accentText : kind === 'danger' ? '#fff' : c.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.btn,
        small && styles.btnSmall,
        {
          backgroundColor: bg,
          borderColor: kind === 'secondary' ? c.line : 'transparent',
          opacity: disabled ? 0.45 : pressed ? 0.75 : 1,
        },
        style,
      ]}>
      <Text style={[styles.btnText, small && { fontSize: 14 }, { color: fg }]}>{title}</Text>
    </Pressable>
  );
}

export function Pill({ label, active, onPress }: { label: string; active?: boolean; onPress?: () => void }) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.pill,
        { backgroundColor: active ? c.accent : 'rgba(0,0,0,0.55)', borderColor: active ? c.accent : 'rgba(255,255,255,0.25)' },
      ]}>
      <Text style={{ color: active ? c.accentText : '#fff', fontWeight: '600', fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

export function Row({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 8 }, style]}>{children}</View>;
}

export const fmtDate = (ms: number | null | undefined) =>
  ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

export const fmtDateTime = (ms: number | null | undefined) =>
  ms
    ? new Date(ms).toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '—';

const styles = StyleSheet.create({
  btn: {
    minHeight: 48,
    paddingHorizontal: 18,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnSmall: { minHeight: 36, paddingHorizontal: 12, borderRadius: 10 },
  btnText: { fontSize: 16, fontWeight: '600' },
  pill: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1 },
});
