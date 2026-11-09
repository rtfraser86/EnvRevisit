import { Image } from 'expo-image';
import { usePermissions } from 'expo-media-library';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, type Region } from 'react-native-maps';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Btn, Pill, fmtDate, useColors } from '@/components/ui';
import { allPhotos, listStations, type PhotoRow, type StationWithStats } from '@/lib/db';
import { distanceM, formatDistance } from '@/lib/geo';
import { scanLibrary, type ScanProgress } from '@/lib/library';
import { usePosition } from '@/lib/sensors';

const NEAR_RADIUS_M = 150; // "you're near photos you took before" threshold
const STRIP_MAX = 40;

type Cluster = { key: string; lat: number; lon: number; ids: string[] };

function clusterPhotos(photos: PhotoRow[], region: Region | null): Cluster[] {
  if (!region) return [];
  const cellLat = region.latitudeDelta / 12;
  const cellLon = region.longitudeDelta / 8;
  const minLat = region.latitude - region.latitudeDelta;
  const maxLat = region.latitude + region.latitudeDelta;
  const minLon = region.longitude - region.longitudeDelta;
  const maxLon = region.longitude + region.longitudeDelta;
  const cells = new Map<string, { lat: number; lon: number; ids: string[] }>();
  for (const p of photos) {
    if (p.lat < minLat || p.lat > maxLat || p.lon < minLon || p.lon > maxLon) continue;
    const key = `${Math.floor(p.lat / cellLat)}:${Math.floor(p.lon / cellLon)}`;
    const c = cells.get(key);
    if (c) {
      c.lat += p.lat;
      c.lon += p.lon;
      c.ids.push(p.id);
    } else cells.set(key, { lat: p.lat, lon: p.lon, ids: [p.id] });
  }
  return [...cells.entries()].map(([key, c]) => ({
    key,
    lat: c.lat / c.ids.length,
    lon: c.lon / c.ids.length,
    ids: c.ids,
  }));
}

export default function MapScreen() {
  const c = useColors();
  const mapRef = useRef<MapView>(null);
  const [perm, requestPerm] = usePermissions({ granularPermissions: ['photo'] });
  const [photos, setPhotos] = useState<PhotoRow[]>([]);
  const [stations, setStations] = useState<StationWithStats[]>([]);
  const [region, setRegion] = useState<Region | null>(null);
  const [scan, setScan] = useState<ScanProgress | null>(null);
  const [satellite, setSatellite] = useState(true);
  const [selection, setSelection] = useState<string[] | null>(null); // ids picked from a cluster
  const { fix } = usePosition(true, false);
  const zoomedToNear = useRef(false);

  const byId = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);

  const reload = useCallback(async () => {
    const [p, s] = await Promise.all([allPhotos(), listStations()]);
    setPhotos(p);
    setStations(s);
  }, []);

  const runScan = useCallback(
    async (full = false) => {
      setScan({ scanned: 0, geotagged: 0, done: false });
      try {
        await scanLibrary(setScan, { full });
      } catch (e) {
        console.warn('scan failed', e);
      }
      await reload();
      setTimeout(() => setScan(null), 2500);
    },
    [reload]
  );

  // Reload stations whenever we come back to the map.
  useFocusEffect(
    useCallback(() => {
      reload();
    }, [reload])
  );

  // First launch / permission granted → incremental scan.
  useEffect(() => {
    if (!perm?.granted) return;
    const t = setTimeout(() => runScan(false), 0);
    return () => clearTimeout(t);
  }, [perm?.granted, runScan]);

  // Things near the user right now.
  const near = useMemo(() => {
    if (!fix) return { photos: [] as (PhotoRow & { d: number })[], stations: [] as (StationWithStats & { d: number })[] };
    const ps = photos
      .map((p) => ({ ...p, d: distanceM(fix, { latitude: p.lat, longitude: p.lon }) }))
      .filter((p) => p.d <= NEAR_RADIUS_M)
      .sort((a, b) => a.d - b.d)
      .slice(0, STRIP_MAX);
    const ss = stations
      .map((s) => ({ ...s, d: distanceM(fix, { latitude: s.lat, longitude: s.lon }) }))
      .filter((s) => s.d <= NEAR_RADIUS_M * 2)
      .sort((a, b) => a.d - b.d);
    return { photos: ps, stations: ss };
  }, [fix, photos, stations]);

  // When you first arrive near previous photos, zoom the map onto them.
  useEffect(() => {
    if (zoomedToNear.current || !fix) return;
    const pts = [...near.photos.map((p) => ({ latitude: p.lat, longitude: p.lon })), ...near.stations.map((s) => ({ latitude: s.lat, longitude: s.lon }))];
    if (!pts.length) return;
    zoomedToNear.current = true;
    mapRef.current?.fitToCoordinates([fix, ...pts], {
      edgePadding: { top: 120, right: 60, bottom: 260, left: 60 },
      animated: true,
    });
  }, [fix, near]);

  const clusters = useMemo(() => clusterPhotos(photos, region), [photos, region]);

  const onClusterPress = (cl: Cluster) => {
    if (cl.ids.length <= 12 || (region && region.longitudeDelta < 0.002)) {
      setSelection(cl.ids);
      return;
    }
    mapRef.current?.animateToRegion(
      {
        latitude: cl.lat,
        longitude: cl.lon,
        latitudeDelta: (region?.latitudeDelta ?? 0.1) / 4,
        longitudeDelta: (region?.longitudeDelta ?? 0.1) / 4,
      },
      350
    );
  };

  const strip: { kind: 'station' | 'photo'; id: string; uri: string | null; label: string; sub: string }[] = useMemo(() => {
    if (selection) {
      return selection
        .map((id) => byId.get(id))
        .filter((p): p is PhotoRow => !!p)
        .sort((a, b) => b.created - a.created)
        .map((p) => ({ kind: 'photo' as const, id: p.id, uri: p.id, label: fmtDate(p.created), sub: '' }));
    }
    return [
      ...near.stations.map((s) => ({
        kind: 'station' as const,
        id: String(s.id),
        uri: s.ref_uri,
        label: s.name,
        sub: `${formatDistance(s.d)} · ${s.n} photo${s.n === 1 ? '' : 's'}`,
      })),
      ...near.photos.map((p) => ({
        kind: 'photo' as const,
        id: p.id,
        uri: p.id,
        label: fmtDate(p.created),
        sub: formatDistance(p.d),
      })),
    ];
  }, [selection, near, byId]);

  const initialRegion: Region = {
    latitude: -19.26, // Townsville — first-run fallback before GPS/photos load
    longitude: 146.82,
    latitudeDelta: 0.6,
    longitudeDelta: 0.6,
  };

  if (perm && !perm.granted) {
    return (
      <SafeAreaView style={[styles.center, { backgroundColor: c.bg }]}>
        <Text style={[styles.h1, { color: c.text }]}>EnvRevisit</Text>
        <Text style={{ color: c.muted, textAlign: 'center', marginBottom: 20, paddingHorizontal: 30 }}>
          EnvRevisit needs access to your photos to map where you&apos;ve taken them before.
        </Text>
        <Btn title="Allow photo access" onPress={() => requestPerm()} />
      </SafeAreaView>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={initialRegion}
        mapType={satellite ? 'hybrid' : 'standard'}
        showsUserLocation
        showsCompass
        onRegionChangeComplete={setRegion}
        onPress={() => setSelection(null)}>
        {clusters.map((cl) => {
          const single = cl.ids.length === 1;
          return (
            <Marker
              key={`p${cl.key}:${cl.ids.length}`}
              coordinate={{ latitude: cl.lat, longitude: cl.lon }}
              tracksViewChanges={false}
              onPress={(e) => {
                e.stopPropagation();
                if (single) router.push({ pathname: '/photo', params: { id: cl.ids[0] } });
                else onClusterPress(cl);
              }}>
              <View
                style={[
                  styles.dot,
                  single
                    ? { width: 14, height: 14 }
                    : { minWidth: 30, height: 30, paddingHorizontal: 6 },
                ]}>
                {!single && <Text style={styles.dotText}>{cl.ids.length > 999 ? '999+' : cl.ids.length}</Text>}
              </View>
            </Marker>
          );
        })}
        {stations.map((s) => (
          <Marker
            key={`s${s.id}`}
            coordinate={{ latitude: s.lat, longitude: s.lon }}
            tracksViewChanges={false}
            onPress={(e) => {
              e.stopPropagation();
              router.push(`/station/${s.id}`);
            }}>
            <View style={[styles.station, { backgroundColor: c.accent }]}>
              <Text style={{ color: c.accentText, fontWeight: '800', fontSize: 12, transform: [{ rotate: '-45deg' }] }}>
                {s.n}
              </Text>
            </View>
          </Marker>
        ))}
      </MapView>

      <SafeAreaView edges={['top']} style={styles.topBar} pointerEvents="box-none">
        <View style={styles.topRow} pointerEvents="box-none">
          <Pill label={satellite ? 'Satellite' : 'Map'} active={satellite} onPress={() => setSatellite((v) => !v)} />
          <Pill
            label={scan && !scan.done ? `Scanning… ${scan.scanned}` : scan?.done ? `+${scan.geotagged} geotagged` : `${photos.length} photos`}
            onPress={() => !scan && runScan(false)}
          />
          {perm?.accessPrivileges === 'limited' && <Pill label="Limited access" onPress={() => requestPerm()} />}
        </View>
      </SafeAreaView>

      <SafeAreaView edges={['bottom']} style={styles.bottom} pointerEvents="box-none">
        {strip.length > 0 && (
          <View style={[styles.sheet, { backgroundColor: c.card }]}>
            <View style={styles.sheetHead}>
              <Text style={{ color: c.text, fontWeight: '700' }}>
                {selection ? `${selection.length} photos here` : `Near you`}
              </Text>
              {selection && (
                <Pressable onPress={() => setSelection(null)} hitSlop={10}>
                  <Text style={{ color: c.accent, fontWeight: '600' }}>Close</Text>
                </Pressable>
              )}
            </View>
            <FlatList
              horizontal
              data={strip}
              keyExtractor={(i) => i.kind + i.id}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 10, paddingHorizontal: 12 }}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() =>
                    item.kind === 'station'
                      ? router.push(`/station/${item.id}`)
                      : router.push({ pathname: '/photo', params: { id: item.id } })
                  }
                  style={{ width: 92 }}>
                  <View>
                    {item.uri ? (
                      <Image source={{ uri: item.uri }} style={styles.thumb} contentFit="cover" recyclingKey={item.uri} />
                    ) : (
                      <View style={[styles.thumb, { backgroundColor: c.line }]} />
                    )}
                    {item.kind === 'station' && (
                      <View style={[styles.badge, { backgroundColor: c.accent }]}>
                        <Text style={{ color: c.accentText, fontSize: 10, fontWeight: '800' }}>STATION</Text>
                      </View>
                    )}
                  </View>
                  <Text numberOfLines={1} style={{ color: c.text, fontSize: 12, fontWeight: '600', marginTop: 4 }}>
                    {item.label}
                  </Text>
                  {!!item.sub && (
                    <Text numberOfLines={1} style={{ color: c.muted, fontSize: 11 }}>
                      {item.sub}
                    </Text>
                  )}
                </Pressable>
              )}
            />
          </View>
        )}
        <View style={styles.actions}>
          <Btn title="Stations" kind="secondary" onPress={() => router.push('/stations')} style={{ flex: 1 }} />
          <Btn
            title="My location"
            kind="secondary"
            disabled={!fix}
            onPress={() =>
              fix &&
              mapRef.current?.animateToRegion(
                { latitude: fix.latitude, longitude: fix.longitude, latitudeDelta: 0.004, longitudeDelta: 0.004 },
                400
              )
            }
            style={{ flex: 1 }}
          />
        </View>
      </SafeAreaView>

      {!perm && (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  h1: { fontSize: 32, fontWeight: '800', marginBottom: 10 },
  topBar: { position: 'absolute', top: 0, left: 0, right: 0 },
  topRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingTop: 6, flexWrap: 'wrap' },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  sheet: { marginHorizontal: 10, borderRadius: 16, paddingVertical: 10, marginBottom: 8 },
  sheetHead: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 12, marginBottom: 8 },
  thumb: { width: 92, height: 92, borderRadius: 10 },
  badge: { position: 'absolute', left: 4, top: 4, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 },
  actions: { flexDirection: 'row', gap: 10, paddingHorizontal: 10, paddingBottom: 6 },
  dot: {
    borderRadius: 999,
    backgroundColor: '#2563EB',
    borderWidth: 2,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotText: { color: '#fff', fontWeight: '800', fontSize: 12 },
  station: {
    width: 28,
    height: 28,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '45deg' }],
  },
});
