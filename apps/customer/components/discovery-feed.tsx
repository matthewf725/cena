import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Text } from './type';
import { discoverPickupFeed, type DiscoveryPage, type PickupOrigin } from '../lib/discovery';
import type { Kitchen } from '../lib/data';
import { KitchenRail } from './kitchen-rail';

export function DiscoveryFeed({ width, side, radius, query, reduced, origin, fromCity, recentIds, open, headerHeight, bottomSpace, onScroll, welcome }: {
  width: number;
  side: number;
  radius: number;
  query: string;
  reduced: boolean;
  origin: PickupOrigin;
  fromCity: boolean;
  recentIds: string[];
  open: (kitchen: Kitchen) => void;
  headerHeight: number;
  bottomSpace: number;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  welcome?: ReactNode;
}) {
  const list = useRef<FlatList<DiscoveryPage['categories'][number]>>(null);
  const [page, setPage] = useState<DiscoveryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [filter, setFilter] = useState(normalizeQuery(query));
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const cursor = useRef<string | null>(null);
  const restaurantRecentKey = recentIds.join(',');

  useEffect(() => {
    const next = normalizeQuery(query);
    if (next === filter) return;
    const wait = setTimeout(() => {
      list.current?.scrollToOffset({ offset: 0, animated: false });
      setFilter(next);
    }, 250);
    return () => clearTimeout(wait);
  }, [query, filter]);

  const load = useCallback(async (append: boolean, requestGeneration: number) => {
    const after = append ? cursor.current : null;
    if (inFlight.current || (append && !after)) return;
    inFlight.current = true;
    setLoading(true);
    setError(false);
    try {
      const result = await discoverPickupFeed({
        origin,
        query: filter,
        after: after ?? undefined,
        recentIds: append || filter || !restaurantRecentKey ? [] : restaurantRecentKey.split(','),
      });
      if (generation.current !== requestGeneration) return;
      const nextCursor = result.nextCursor === after ? null : result.nextCursor;
      cursor.current = nextCursor;
      setPage(previous => {
        if (!append || !previous) return { ...result, nextCursor };
        const seen = new Set(previous.categories.map(category => category.name.toLowerCase()));
        return {
          ...previous,
          nearby: [...previous.nearby, ...result.nearby.filter(kitchen => !previous.nearby.some(existing => existing.id === kitchen.id))],
          categories: [...previous.categories, ...result.categories.filter(category => !seen.has(category.name.toLowerCase()))],
          nextCursor,
        };
      });
    } catch {
      if (generation.current === requestGeneration) setError(true);
    } finally {
      if (generation.current === requestGeneration) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }, [origin, filter, restaurantRecentKey]);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    inFlight.current = false;
    cursor.current = null;
    setPage(null);
    void load(false, requestGeneration);
    return () => { generation.current++; };
  }, [load, retry]);

  useEffect(() => {
    if (!loading && !error && page?.nextCursor && viewportHeight > 0 && contentHeight <= viewportHeight + 24) {
      void load(true, generation.current);
    }
  }, [contentHeight, error, load, loading, page?.nextCursor, viewportHeight]);

  const loadMore = () => {
    if (!error) void load(true, generation.current);
  };
  const rail = { width, radius, open, reduced, fromCity };
  const content = (
    <>
      {welcome}
      {page && (
        <>
          {!filter && (page.recents.length > 0
            ? <KitchenRail title="Recents" kitchens={page.recents} {...rail} />
            : <View style={styles.empty}>
              <Text accessibilityRole="header" style={styles.heading}>Recents</Text>
              <Text style={styles.help}>Restaurants you order from will appear here.</Text>
            </View>)}
          {page.nearby.length ? <KitchenRail title={filter ? 'Matching restaurants' : 'Near you'} kitchens={page.nearby} {...rail} />
            : <View style={styles.empty}>
              <Text accessibilityRole="header" style={styles.heading}>{filter ? 'Matching restaurants' : 'Near you'}</Text>
              <Text style={styles.help}>{filter ? 'No restaurants match that search.' : 'No restaurants have pickup windows right now.'}</Text>
            </View>}
        </>
      )}
    </>
  );
  const footer = loading ? <ActivityIndicator color={maroon} accessibilityLabel="Loading kitchens" style={styles.footer} />
    : error ? <Pressable accessibilityRole="button" style={styles.footer} onPress={() => {
      if (page && cursor.current) void load(true, generation.current);
      else setRetry(count => count + 1);
    }}><Text style={styles.price}>Couldn’t load kitchens. Tap to retry.</Text></Pressable>
    : null;

  return (
    <FlatList ref={list} data={page?.categories ?? []} keyExtractor={item => item.name}
      ListHeaderComponent={content} ListFooterComponent={footer}
      renderItem={({ item }) => <KitchenRail title={item.name.split(' · ')[0]} kitchens={item.kitchens} {...rail} />}
      onEndReached={loadMore} onEndReachedThreshold={0.65}
      onLayout={event => setViewportHeight(event.nativeEvent.layout.height)}
      onContentSizeChange={(_width, height) => setContentHeight(height)}
      onScroll={onScroll} scrollEventThrottle={16}
      showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled"
      initialNumToRender={4} maxToRenderPerBatch={4} windowSize={5}
      contentContainerStyle={{ paddingHorizontal: side, paddingTop: headerHeight + 12, paddingBottom: bottomSpace }}
    />
  );
}

const maroon = '#5D100A';
const ink = '#271D19';
const muted = '#77645B';
const normalizeQuery = (query: string) => Array.from(query.trim()).slice(0, 120).join('');
const styles = StyleSheet.create({
  empty: { marginBottom: 20 },
  heading: { fontWeight:'500', color: ink, fontSize: 25, lineHeight: 30, marginBottom: 10 },
  help: { color: muted, fontSize: 14 },
  price: { color: maroon, fontSize: 14, fontWeight: '500', marginTop: 3 },
  footer: { paddingVertical: 16, alignItems: 'center' },
});
