import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, FlatList, Image, Pressable, ScrollView, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { ArrowRight, Beef, Clock3, Coffee, DollarSign, Fish, Flame, Globe2, Leaf, Pizza, Salad, Soup, Tag, Wallet } from 'lucide-react-native';
import { Text } from './type';
import { discoverPickupFeed, discoverPickupResults, getCachedPickupFeed, type DiscoveryFilters, type DiscoveryPage, type PickupOrigin } from '../lib/discovery';
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
  const [promoIndex, setPromoIndex] = useState(0);
  const [promoPaused, setPromoPaused] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const generation = useRef(0);
  const lastRetry = useRef(0);
  const inFlight = useRef(false);
  const cursor = useRef<string | null>(null);
  const resultsGeneration = useRef(0);
  const resultsInFlight = useRef(false);
  const resultsOffset = useRef<number | null>(null);
  const promoScroll = useRef<ScrollView>(null);
  const promoIndexRef = useRef(0);
  const promoPauseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restaurantRecentKey = recentIds.join(',');
  const resultsMode = Boolean(filter || selectedFilters.maxPriceCents || selectedFilters.offersOnly || selectedFilters.sameDayOnly || selectedFilters.cuisine);
  const nearbyPromoItems = page?.nearby ?? [];
  const lunaRedIndex = nearbyPromoItems.findIndex(kitchen => kitchen.id === 'cal-poly-luna-red' || kitchen.name.toLowerCase().includes('luna red'));
  const promoItems = lunaRedIndex > 0
    ? [nearbyPromoItems[lunaRedIndex], ...nearbyPromoItems.slice(0, lunaRedIndex), ...nearbyPromoItems.slice(lunaRedIndex + 1)]
    : nearbyPromoItems;
  const promoItemsKey = promoItems.map(kitchen => kitchen.id).join(',');
  const promoCardWidth = Math.max(1, width - side * 2);
  const promoStride = promoCardWidth + 10;

  useEffect(() => {
    promoIndexRef.current = 0;
    setPromoIndex(0);
    promoScroll.current?.scrollTo({ x: 0, animated: false });
  }, [promoItemsKey]);

  useEffect(() => {
    promoScroll.current?.scrollTo({ x: promoIndexRef.current * promoStride, animated: false });
  }, [promoStride]);

  useEffect(() => {
    if (reduced || suspended || resultsMode || promoPaused || promoItems.length < 2) return;
    const timer = setTimeout(() => {
      const next = (promoIndexRef.current + 1) % promoItems.length;
      promoIndexRef.current = next;
      setPromoIndex(next);
      promoScroll.current?.scrollTo({ x: next * promoStride, animated: true });
    }, 1500);
    return () => clearTimeout(timer);
  }, [promoIndex, promoItems.length, promoItemsKey, promoPaused, promoStride, reduced, resultsMode, suspended]);

  useEffect(() => () => {
    if (promoPauseTimer.current) clearTimeout(promoPauseTimer.current);
  }, []);

  useEffect(() => {
    const next = normalizeQuery(query);
    if (next === filter) return;
    const wait = setTimeout(() => {
      list.current?.scrollToOffset({ offset: 0, animated: false });
      setFilter(next);
    }, 250);
    return () => clearTimeout(wait);
  }, [query, filter]);

  const load = useCallback(async (append: boolean, requestGeneration: number, forceRefresh = false) => {
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
      }, { forceRefresh });
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
    const snapshot = getCachedPickupFeed({ origin, query: '', recentIds: [] });
    setPage(snapshot);
    if (snapshot) { cursor.current = snapshot.nextCursor; setLoading(false); }
    const forceRefresh = retry !== lastRetry.current;
    lastRetry.current = retry;
    void load(false, requestGeneration, forceRefresh);
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
  const pausePromo = () => {
    setPromoPaused(true);
    if (promoPauseTimer.current) clearTimeout(promoPauseTimer.current);
    promoPauseTimer.current = setTimeout(() => setPromoPaused(false), 8000);
  };
  const navigatePromo = (index: number) => {
    const next = Math.max(0, Math.min(index, promoItems.length - 1));
    promoIndexRef.current = next;
    setPromoIndex(next);
    promoScroll.current?.scrollTo({ x: next * promoStride, animated: !reduced });
    pausePromo();
  };
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
  const filterPill = (label: string, selected: boolean, onPress: () => void, icon: ReactNode, wash: string) => (
    <Pressable key={label} accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress}
      style={[styles.filterPill, selected && styles.filterPillSelected]}>
      <View style={[styles.filterPillIcon, { backgroundColor: selected ? '#FFFFFF' : wash }]}>{icon}</View>
      <Text style={[styles.filterPillText, selected && styles.filterPillTextSelected]}>{label}</Text>
    </Pressable>
  );
  const filterControls = (
    <View style={styles.filters}>
      {cuisineOptions.length > 0 && <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.cuisineRow}>
        {cuisineOptions.map((cuisine, index) => {
          const color = cuisineColors[index % cuisineColors.length];
          const selected = selectedFilters.cuisine === cuisine;
          return <Pressable key={cuisine} accessibilityRole="button" accessibilityState={{ selected }} onPress={() => chooseCuisine(cuisine)} style={styles.cuisineButton}>
            <View style={[styles.cuisineIconCircle, { backgroundColor: selected ? '#F1D8CE' : `${color}1B`, borderColor: selected ? maroon : 'transparent' }]}>
              {cuisineIcon(cuisine, color)}
            </View>
            <Text numberOfLines={1} style={[styles.cuisineLabel, selected && styles.cuisineLabelSelected]}>{cuisine}</Text>
          </Pressable>;
        })}
      </ScrollView>}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.filterPills}>
        {filterPill('Under $15', selectedFilters.maxPriceCents === 1500, () => choosePrice(1500), <DollarSign size={14} color="#B45E2D" aria-hidden/>, '#F8E8DC')}
        {filterPill('Under $20', selectedFilters.maxPriceCents === 2000, () => choosePrice(2000), <Wallet size={14} color="#567543" aria-hidden/>, '#E9F0E2')}
        {filterPill('Offers', selectedFilters.offersOnly, () => updateFilters(previous => ({ ...previous, offersOnly: !previous.offersOnly })), <Tag size={14} color="#AA4962" aria-hidden/>, '#F7E4E9')}
        {filterPill('Same-day pickup', selectedFilters.sameDayOnly, () => updateFilters(previous => ({ ...previous, sameDayOnly: !previous.sameDayOnly })), <Clock3 size={14} color="#3F7C8A" aria-hidden/>, '#E3F0F2')}
      </ScrollView>
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
  const promoCarousel = !resultsMode && promoItems.length > 0 ? <View style={styles.promoSection}>
    <ScrollView ref={promoScroll} horizontal snapToInterval={promoStride} decelerationRate="fast" disableIntervalMomentum
      showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.promoTrack}
      onScrollBeginDrag={pausePromo}
      onMomentumScrollEnd={event => {
        const next = Math.max(0, Math.min(promoItems.length - 1, Math.round(event.nativeEvent.contentOffset.x / promoStride)));
        promoIndexRef.current = next;
        setPromoIndex(next);
      }}>
      {promoItems.map((restaurant, index) => <Pressable key={restaurant.id} accessibilityRole="button"
        accessibilityLabel={`Featured restaurant: view ${restaurant.name} menu`} onPressIn={pausePromo}
        onPress={() => open(restaurant)} style={[styles.featuredPromo, { width: promoCardWidth, borderRadius: radius }] }>
        <View style={styles.featuredCopy}>
          <Text style={styles.featuredEyebrow}>{index === 0 ? 'FEATURED NEAR YOU' : 'MORE NEARBY'}</Text>
          <Text numberOfLines={2} style={styles.featuredName}>{restaurant.name}</Text>
          <View style={styles.featuredLink}><Text numberOfLines={1} style={styles.featuredLinkText}>{restaurant.cuisine} · View menu</Text><ArrowRight size={14} color="#FAF6F3" aria-hidden /></View>
        </View>
        <Image source={restaurantPhoto(restaurant)} resizeMode="contain" aria-hidden style={styles.featuredImage} />
      </Pressable>)}
    </ScrollView>
    {promoItems.length > 1 && <View style={styles.promoDots} accessibilityLabel="Featured restaurant carousel">
      {promoItems.map((restaurant, index) => <Pressable key={restaurant.id} accessibilityRole="button" accessibilityLabel={`Show featured restaurant ${index + 1}`}
        accessibilityState={{ selected: promoIndex === index }} onPress={() => navigatePromo(index)} style={styles.promoDotTarget}>
        <View style={[styles.promoDot, promoIndex === index && styles.promoDotActive]} />
      </Pressable>)}
    </View>}
  </View> : null;
  const content = (
    <>
      {filterControls}
      {promoCarousel}
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
      if (page && cursor.current) void load(true, generation.current, true);
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
const cuisineColors = ['#C65A43', '#4C8A79', '#C27A2C', '#8263A9', '#3D8193', '#A35166'];
const normalizeQuery = (query: string) => Array.from(query.trim()).slice(0, 120).join('');

function cuisineIcon(cuisine: string, color: string) {
  const name = cuisine.toLowerCase();
  const Icon = /italian|pizza/.test(name) ? Pizza
    : /mexican|taco|spicy/.test(name) ? Flame
      : /cafe|breakfast|coffee|bakery/.test(name) ? Coffee
        : /mediterranean|vegetarian|vegan|salad/.test(name) ? Salad
          : /japanese|sushi|seafood|fish/.test(name) ? Fish
            : /barbecue|bbq|american|steak|burger/.test(name) ? Beef
              : /indian|thai|chinese|korean|asian|noodle/.test(name) ? Soup
                : /french|bistro|wine/.test(name) ? Leaf : Globe2;
  return <Icon size={23} color={color} strokeWidth={1.9} aria-hidden />;
}

const styles = StyleSheet.create({
  filters: { marginBottom: 12 },
  cuisineRow: { gap: 14, paddingRight: 4, paddingBottom: 13 },
  cuisineButton: { width: 70, alignItems: 'center', gap: 5 },
  cuisineIconCircle: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', borderWidth: 2 },
  cuisineLabel: { color: ink, fontSize: 12, lineHeight: 15, textAlign: 'center', maxWidth: 70 },
  cuisineLabelSelected: { color: maroon, fontWeight: '700' },
  filterPills: { gap: 8, paddingRight: 4, paddingVertical: 2 },
  filterPill: { minHeight: 37, borderWidth: 1, borderColor: '#E4D6CE', backgroundColor: '#FFFDFA', borderRadius: 19, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 6 },
  filterPillIcon: { width: 23, height: 23, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
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
  promoSection: { marginBottom: 14 },
  promoTrack: { gap: 10 },
  featuredPromo: { minHeight: 108, height: 108, overflow: 'hidden', flexDirection: 'row', backgroundColor: maroon },
  featuredCopy: { flex: 1, minWidth: 0, justifyContent: 'center', paddingHorizontal: 15, paddingVertical: 11 },
  featuredEyebrow: { color: '#EACFC5', fontSize: 9, letterSpacing: 1.2, fontWeight: '600', marginBottom: 4 },
  featuredName: { color: '#FFF9F5', fontSize: 19, lineHeight: 22, fontWeight: '600' },
  featuredLink: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 6 },
  featuredLinkText: { color: '#FFF9F5', fontSize: 12, fontWeight: '500' },
  featuredImage: { width: '46%', height: '100%', alignSelf: 'stretch', backgroundColor: '#3D211A' },
  promoDots: { height: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3 },
  promoDotTarget: { width: 20, height: 20, alignItems: 'center', justifyContent: 'center' },
  promoDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#D7C7BF' },
  promoDotActive: { width: 18, backgroundColor: maroon },
  empty: { marginBottom: 20 },
  heading: { fontWeight:'500', color: ink, fontSize: 25, lineHeight: 30, marginBottom: 10 },
  help: { color: muted, fontSize: 14 },
  price: { color: maroon, fontSize: 14, fontWeight: '500', marginTop: 3 },
  footer: { paddingVertical: 16, alignItems: 'center' },
});
