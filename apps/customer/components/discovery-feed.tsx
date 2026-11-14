import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, ScrollView, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { ArrowRight, SlidersHorizontal } from 'lucide-react-native';
import { Text } from './type';
import { discoverPickupFeed, discoverPickupResults, type DiscoveryFilters, type DiscoveryPage, type PickupOrigin } from '../lib/discovery';
import { supabase } from '../lib/supabase';
import type { Kitchen } from '../lib/data';
import { KitchenCard, KitchenRail } from './kitchen-rail';
import { restaurantPhoto } from '../lib/restaurant-presentation';

export function DiscoveryFeed({ width, side, radius, query, reduced, origin, recentIds, open, topSpace, bottomSpace, onScroll, suspended, clearQuery }: {
  width: number;
  side: number;
  radius: number;
  query: string;
  reduced: boolean;
  suspended: boolean;
  origin: PickupOrigin;
  recentIds: string[];
  open: (kitchen: Kitchen) => void;
  clearQuery?: () => void;
  topSpace: number;
  bottomSpace: number;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
}) {
  const list = useRef<FlatList<DiscoveryPage['categories'][number]>>(null);
  const [page, setPage] = useState<DiscoveryPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [filter, setFilter] = useState(normalizeQuery(query));
  const [selectedFilters, setSelectedFilters] = useState<DiscoveryFilters>({ maxPriceCents: null, offersOnly: false, sameDayOnly: false, cuisine: null });
  const [filteredKitchens, setFilteredKitchens] = useState<Kitchen[]>([]);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [resultsError, setResultsError] = useState(false);
  const [nextResultsOffset, setNextResultsOffset] = useState<number | null>(null);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const cursor = useRef<string | null>(null);
  const resultsGeneration = useRef(0);
  const resultsInFlight = useRef(false);
  const resultsOffset = useRef<number | null>(null);
  const restaurantRecentKey = recentIds.join(',');
  const resultsMode = Boolean(filter || selectedFilters.maxPriceCents || selectedFilters.offersOnly || selectedFilters.sameDayOnly || selectedFilters.cuisine);

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
        query: '',
        after: after ?? undefined,
        recentIds: append || !restaurantRecentKey ? [] : restaurantRecentKey.split(','),
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
  }, [origin, restaurantRecentKey]);

  useEffect(() => {
    const requestGeneration = ++generation.current;
    inFlight.current = false;
    cursor.current = null;
    setPage(null);
    void load(false, requestGeneration);
    return () => { generation.current++; };
  }, [load, retry]);

  const loadFiltered = useCallback(async (append: boolean, requestGeneration: number) => {
    if (resultsInFlight.current || (append && resultsOffset.current === null)) return;
    resultsInFlight.current = true;
    setResultsLoading(true);
    setResultsError(false);
    const offset = append ? resultsOffset.current ?? 0 : 0;
    try {
      const result = await discoverPickupResults({ origin, query: filter, filters: selectedFilters, offset });
      if (resultsGeneration.current !== requestGeneration) return;
      setFilteredKitchens(previous => append ? [...previous, ...result.kitchens.filter(kitchen => !previous.some(existing => existing.id === kitchen.id))] : result.kitchens);
      resultsOffset.current = result.nextOffset;
      setNextResultsOffset(result.nextOffset);
    } catch {
      if (resultsGeneration.current === requestGeneration) setResultsError(true);
    } finally {
      if (resultsGeneration.current === requestGeneration) {
        resultsInFlight.current = false;
        setResultsLoading(false);
      }
    }
  }, [filter, origin, selectedFilters]);

  useEffect(() => {
    const requestGeneration = ++resultsGeneration.current;
    resultsInFlight.current = false;
    resultsOffset.current = null;
    setFilteredKitchens([]);
    setNextResultsOffset(null);
    if (!resultsMode) {
      setResultsLoading(false);
      setResultsError(false);
      return;
    }
    void loadFiltered(false, requestGeneration);
    return () => { resultsGeneration.current++; };
  }, [loadFiltered, resultsMode]);

  useEffect(() => {
    if (!resultsMode && !loading && !error && page?.nextCursor && viewportHeight > 0 && contentHeight <= viewportHeight + 24) {
      void load(true, generation.current);
    }
  }, [contentHeight, error, load, loading, page?.nextCursor, resultsMode, viewportHeight]);

  const loadMore = () => {
    if (resultsMode) {
      if (!resultsError && resultsOffset.current !== null) void loadFiltered(true, resultsGeneration.current);
    } else if (!error) void load(true, generation.current);
  };
  const rail = { width, radius, open, reduced, suspended };
  const updateFilters = (update: (previous: DiscoveryFilters) => DiscoveryFilters) => {
    list.current?.scrollToOffset({ offset: 0, animated: !reduced });
    setSelectedFilters(update);
  };
  const chooseCuisine = (cuisine: string) => updateFilters(previous => ({ ...previous, cuisine: previous.cuisine === cuisine ? null : cuisine }));
  const choosePrice = (price: number) => updateFilters(previous => ({ ...previous, maxPriceCents: previous.maxPriceCents === price ? null : price }));
  const clearFilters = () => {
    list.current?.scrollToOffset({ offset: 0, animated: !reduced });
    setSelectedFilters({ maxPriceCents: null, offersOnly: false, sameDayOnly: false, cuisine: null });
    clearQuery?.();
    setFilter('');
  };
  const cuisineOptions = Array.from(new Map((page?.categories ?? []).map(category => [category.name.toLowerCase(), category.name])).values());
  const activeFilterLabels = [
    selectedFilters.maxPriceCents !== null ? `Under $${selectedFilters.maxPriceCents / 100}` : null,
    selectedFilters.offersOnly ? 'Offers' : null,
    selectedFilters.sameDayOnly ? 'Same-day pickup' : null,
    selectedFilters.cuisine,
    filter || null,
  ].filter(Boolean);
  const filterPill = (label: string, selected: boolean, onPress: () => void) => (
    <Pressable key={label} accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress}
      style={[styles.filterPill, selected && styles.filterPillSelected]}>
      <Text style={[styles.filterPillText, selected && styles.filterPillTextSelected]}>{label}</Text>
    </Pressable>
  );
  const filterControls = (
    <View style={styles.filters}>
      <View style={styles.filterHeading}><SlidersHorizontal size={15} color={maroon} aria-hidden/><Text style={styles.filterHeadingText}>Discover</Text></View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.filterPills}>
        {filterPill('Under $15', selectedFilters.maxPriceCents === 1500, () => choosePrice(1500))}
        {filterPill('Under $20', selectedFilters.maxPriceCents === 2000, () => choosePrice(2000))}
        {filterPill('Offers', selectedFilters.offersOnly, () => updateFilters(previous => ({ ...previous, offersOnly: !previous.offersOnly })))}
        {filterPill('Same-day pickup', selectedFilters.sameDayOnly, () => updateFilters(previous => ({ ...previous, sameDayOnly: !previous.sameDayOnly })))}
      </ScrollView>
      {cuisineOptions.length > 0 && <><Text style={styles.filterSubheading}>Cuisines</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.filterPills}>
        {cuisineOptions.map(cuisine => filterPill(cuisine, selectedFilters.cuisine === cuisine, () => chooseCuisine(cuisine)))}
      </ScrollView></>}
    </View>
  );
  const filteredContent = (
    <View>
      <View style={styles.resultsHeading}>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text accessibilityRole="header" style={styles.heading}>Matching restaurants</Text>
          <Text style={styles.help}>{activeFilterLabels.join(' · ') || 'Based on your search'}</Text>
        </View>
        <Pressable accessibilityRole="button" onPress={clearFilters} style={styles.clearButton}><Text style={styles.clearText}>Clear</Text></Pressable>
      </View>
      {filteredKitchens.length ? <View style={styles.resultsGrid}>
        {filteredKitchens.map(kitchen => <KitchenCard key={kitchen.id} kitchen={kitchen} width={width >= 720 ? Math.floor((width - side * 2 - 12) / 2) : Math.max(1, width - side * 2)} radius={radius} open={open} suspended={suspended} />)}
      </View>
        : !resultsLoading && !resultsError ? <View style={styles.emptyResults}><Text style={styles.help}>No restaurants match these filters right now.</Text></View> : null}
      {resultsError && <Pressable accessibilityRole="button" style={styles.footer} onPress={() => loadFiltered(false, resultsGeneration.current)}><Text style={styles.price}>Couldn’t load filtered restaurants. Tap to retry.</Text></Pressable>}
      {!resultsLoading && !resultsError && nextResultsOffset !== null && <Pressable accessibilityRole="button" style={styles.moreButton} onPress={loadMore}><Text style={styles.moreText}>Show more restaurants</Text><ArrowRight size={15} color={maroon} aria-hidden/></Pressable>}
    </View>
  );
  const featured = page?.nearby.find(kitchen => kitchen.name.toLowerCase().includes('luna red')) ?? page?.nearby[0];
  const featuredPromo = !resultsMode && featured ? (
    <Pressable accessibilityRole="button" accessibilityLabel={`Featured restaurant: view ${featured.name} menu`}
      onPress={() => open(featured)} style={[styles.featuredPromo, { borderRadius: radius }]}>
      <View style={styles.featuredCopy}>
        <Text style={styles.featuredEyebrow}>FEATURED NEAR YOU</Text>
        <Text numberOfLines={2} style={styles.featuredName}>{featured.name}</Text>
        <View style={styles.featuredLink}><Text style={styles.featuredLinkText}>{featured.cuisine} · View menu</Text><ArrowRight size={14} color="#FAF6F3" aria-hidden /></View>
      </View>
      <Image source={restaurantPhoto(featured)} resizeMode="cover" aria-hidden style={styles.featuredImage} />
    </Pressable>
  ) : null;
  const content = (
    <>
      {featuredPromo}
      {filterControls}
      {resultsMode ? filteredContent : page && (
        <>
          {page.recents.length > 0
            ? <KitchenRail title="Recents" kitchens={page.recents} {...rail} />
            : <View style={styles.empty}>
              <Text accessibilityRole="header" style={styles.heading}>Recents</Text>
              <Text style={styles.help}>Restaurants you order from will appear here.</Text>
            </View>}
          {page.nearby.length ? <KitchenRail title="Near you" kitchens={page.nearby} {...rail} />
            : <View style={styles.empty}>
              <Text accessibilityRole="header" style={styles.heading}>Near you</Text>
              <Text style={styles.help}>No restaurants have pickup windows right now.</Text>
            </View>}
        </>
      )}
    </>
  );
  const footer = !supabase ? <Text style={styles.help}>Restaurants are unavailable until this preview connects to Supabase.</Text>
    : resultsMode ? resultsLoading ? <ActivityIndicator color={maroon} accessibilityLabel="Loading filtered restaurants" style={styles.footer} /> : null
    : loading ? <ActivityIndicator color={maroon} accessibilityLabel="Loading kitchens" style={styles.footer} />
    : error ? <Pressable accessibilityRole="button" style={styles.footer} onPress={() => {
      if (page && cursor.current) void load(true, generation.current);
      else setRetry(count => count + 1);
    }}><Text style={styles.price}>Couldn’t load kitchens. Tap to retry.</Text></Pressable>
    : null;

  return (
    <FlatList ref={list} data={resultsMode ? [] : page?.categories ?? []} keyExtractor={item => item.name}
      ListHeaderComponent={content} ListFooterComponent={footer}
      renderItem={({ item }) => <KitchenRail title={item.name.split(' · ')[0]} kitchens={item.kitchens} {...rail} />}
      onEndReached={loadMore} onEndReachedThreshold={0.65}
      onLayout={event => setViewportHeight(event.nativeEvent.layout.height)}
      onContentSizeChange={(_width, height) => setContentHeight(height)}
      onScroll={onScroll} scrollEventThrottle={16}
      showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled"
      initialNumToRender={4} maxToRenderPerBatch={4} windowSize={5}
      contentContainerStyle={{ paddingHorizontal: side, paddingTop: topSpace, paddingBottom: bottomSpace }}
    />
  );
}

const maroon = '#5D100A';
const ink = '#271D19';
const muted = '#77645B';
const normalizeQuery = (query: string) => Array.from(query.trim()).slice(0, 120).join('');
const styles = StyleSheet.create({
  filters: { marginBottom: 16 },
  filterHeading: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 8 },
  filterHeadingText: { color: ink, fontSize: 15, fontWeight: '600' },
  filterSubheading: { color: muted, fontSize: 12, marginTop: 2, marginBottom: 7 },
  filterPills: { gap: 8, paddingRight: 4, paddingBottom: 8 },
  filterPill: { minHeight: 36, borderWidth: 1, borderColor: '#E4D6CE', backgroundColor: '#FFFDFA', borderRadius: 18, paddingHorizontal: 12, justifyContent: 'center' },
  filterPillSelected: { backgroundColor: maroon, borderColor: maroon },
  filterPillText: { color: ink, fontSize: 13, fontWeight: '500' },
  filterPillTextSelected: { color: '#FFF9F5' },
  resultsHeading: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 5, marginBottom: 14 },
  resultsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 18 },
  clearButton: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18, borderWidth: 1, borderColor: '#D9C2B9' },
  clearText: { color: maroon, fontSize: 13, fontWeight: '600' },
  emptyResults: { paddingVertical: 18, marginBottom: 12 },
  moreButton: { minHeight: 44, borderRadius: 10, borderWidth: 1, borderColor: '#D9C2B9', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 20 },
  moreText: { color: maroon, fontSize: 14, fontWeight: '600' },
  featuredPromo: { minHeight: 102, height: 108, overflow: 'hidden', flexDirection: 'row', backgroundColor: maroon, marginBottom: 20 },
  featuredCopy: { flex: 1, minWidth: 0, justifyContent: 'center', paddingHorizontal: 15, paddingVertical: 11 },
  featuredEyebrow: { color: '#EACFC5', fontSize: 9, letterSpacing: 1.2, fontWeight: '600', marginBottom: 4 },
  featuredName: { color: '#FFF9F5', fontSize: 19, lineHeight: 22, fontWeight: '600' },
  featuredLink: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 },
  featuredLinkText: { color: '#FFF9F5', fontSize: 12, fontWeight: '500' },
  featuredImage: { width: '34%', alignSelf: 'stretch', backgroundColor: '#A45D4C' },
  empty: { marginBottom: 20 },
  heading: { fontWeight:'500', color: ink, fontSize: 25, lineHeight: 30, marginBottom: 10 },
  help: { color: muted, fontSize: 14 },
  price: { color: maroon, fontSize: 14, fontWeight: '500', marginTop: 3 },
  footer: { paddingVertical: 16, alignItems: 'center' },
});
