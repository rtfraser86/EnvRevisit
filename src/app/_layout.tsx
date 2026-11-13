import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { getDb } from '@/lib/db';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const scheme = useColorScheme();

  useEffect(() => {
    getDb()
      .catch((e) => console.warn('DB init failed', e))
      .finally(() => SplashScreen.hideAsync());
  }, []);

  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerBackButtonDisplayMode: 'minimal' }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="stations" options={{ title: 'Stations' }} />
        <Stack.Screen name="photo" options={{ title: 'Photo' }} />
        <Stack.Screen name="station/[id]" options={{ title: 'Station' }} />
        <Stack.Screen name="add-photos/[id]" options={{ title: 'Add from camera roll' }} />
        <Stack.Screen name="navigate/[id]" options={{ title: 'Navigate' }} />
        {/* A normal card (not a modal) so the timeline and marker screens can be pushed on top of it. */}
        <Stack.Screen name="capture/[id]" options={{ headerShown: false, animation: 'fade', gestureEnabled: false }} />
        <Stack.Screen name="markers/[id]" options={{ title: 'Markers' }} />
        <Stack.Screen name="timeline/[id]" options={{ title: 'Timeline' }} />
      </Stack>
    </ThemeProvider>
  );
}
