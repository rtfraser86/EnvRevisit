import { useState } from 'react';
import { View, type GestureResponderEvent, type LayoutChangeEvent, type ViewStyle } from 'react-native';

/** Minimal dependency-free slider (0–1). Works in Expo Go. */
export function Slider({
  value,
  onChange,
  style,
  trackColor = 'rgba(255,255,255,0.35)',
  fillColor = '#3FB68B',
  thumbColor = '#fff',
}: {
  value: number;
  onChange: (v: number) => void;
  style?: ViewStyle;
  trackColor?: string;
  fillColor?: string;
  thumbColor?: string;
}) {
  const [width, setWidth] = useState(1);

  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.max(1, e.nativeEvent.layout.width));
  const handle = (e: GestureResponderEvent) =>
    onChange(Math.max(0, Math.min(1, e.nativeEvent.locationX / width)));

  const x = value * width;
  return (
    <View
      onLayout={onLayout}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={handle}
      onResponderMove={handle}
      style={[{ height: 40, justifyContent: 'center' }, style]}
      hitSlop={{ top: 10, bottom: 10 }}>
      <View pointerEvents="none" style={{ height: 4, borderRadius: 2, backgroundColor: trackColor }}>
        <View style={{ width: x, height: 4, borderRadius: 2, backgroundColor: fillColor }} />
      </View>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: x - 12,
          width: 24,
          height: 24,
          borderRadius: 12,
          backgroundColor: thumbColor,
          shadowColor: '#000',
          shadowOpacity: 0.3,
          shadowRadius: 3,
          shadowOffset: { width: 0, height: 1 },
        }}
      />
    </View>
  );
}
