import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, ImageBackground, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Search } from 'lucide-react-native';
import { discoverPickupFeed, type DiscoveryPage, type MealTile, type PickupOrigin } from '../lib/discovery';
import type { Kitchen } from '../lib/data';
import { foodPhoto } from '../lib/food-photos';
import { KitchenRail } from './kitchen-rail';

export function DiscoveryFeed({ width, radius, query, setQuery, reduced, origin, fromCity, recentIds, open, openMeal, saved, toggleSaved }: {
  width: number;
  radius: number;
  query: string;
  setQuery: (query: string) => void;
  reduced: boolean;
  origin: PickupOrigin;
  fromCity: boolean;
  recentIds: string[];
  open: (kitchen: Kitchen) => void;
  openMeal: (entry: MealTile) => void;
  saved: string[];
  toggleSaved: (id: string) => void;
}) {
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
  const recentKey = recentIds.join(',');

  useEffect(() => {
    const wait = setTimeout(() => setFilter(normalizeQuery(query)), 250);
    return () => clearTimeout(wait);
  }, [query]);

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
        recentIds: append || !recentKey ? [] : recentKey.split(','),
      });
      if (generation.current !== requestGeneration) return;
      const nextCursor = result.nextCursor === after ? null : result.nextCursor;
      cursor.current = nextCursor;
      setPage(previous => {
        if (!append || !previous) return { ...result, nextCursor };
        const seen = new Set(previous.categories.map(category => category.name.toLowerCase()));
        return {
          ...previous,
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
  }, [origin, filter, recentKey]);

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
  const rail = { width, radius, open, reduced, fromCity, saved, toggleSaved };
  const content = (
    <>
      <View style={styles.search}>
        <Search size={18} color={muted} />
        <TextInput accessibilityLabel="Search restaurants and meal kits" value={query} onChangeText={setQuery}
          placeholder="Search restaurants and meal kits" placeholderTextColor={muted} style={styles.input} maxLength={120}
          autoCorrect={false} returnKeyType="search" />
      </View>
      {page && (
        <>
          {!filter && (page.recents.length > 0
            ? <KitchenRail title="Recents" kitchens={page.recents} {...rail} />
            : <View style={styles.empty}>
              <Text accessibilityRole="header" style={styles.heading}>Recents</Text>
              <Text style={styles.help}>Kitchens you order from will appear here.</Text>
            </View>)}
          <View style={styles.meals}>
            <Text accessibilityRole="header" style={styles.heading}>Explore meal kits</Text>
            {page.explore.length > 0 ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled"
                decelerationRate={reduced ? 'normal' : 'fast'} snapToInterval={reduced ? undefined : 168}
                contentContainerStyle={styles.mealRail}>
                {page.explore.map(entry => {
                  const { meal } = entry;
                  return (
                    <Pressable key={meal.id} accessibilityRole="button" accessibilityLabel={`View ${meal.name}`}
                      onPress={() => openMeal(entry)} style={({ pressed }) => [styles.tile, pressed && styles.pressed]}>
                      <ImageBackground source={foodPhoto(meal.image.startsWith('http') ? meal.id : meal.image)}
                        resizeMode="cover" style={[styles.photo, { borderRadius: radius }]} />
                      <Text numberOfLines={2} style={styles.mealName}>{meal.name}</Text>
                      <Text numberOfLines={1} style={styles.kitchen}>{entry.kitchen.name}</Text>
                      <Text style={styles.price}>${meal.price.toFixed(2)}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : <Text style={styles.help}>{filter ? 'No matching meal kits.' : 'No meal kits available right now.'}</Text>}
          </View>
          {page.nearby.length ? <KitchenRail title={filter ? 'Matching kitchens' : 'Near you'} kitchens={page.nearby} {...rail} />
            : <View style={styles.empty}>
              <Text accessibilityRole="header" style={styles.heading}>{filter ? 'Matching kitchens' : 'Near you'}</Text>
              <Text style={styles.help}>{filter ? 'No kitchens match that search.' : 'No kitchens have pickup windows right now.'}</Text>
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
    <FlatList data={page?.categories ?? []} keyExtractor={item => item.name}
      ListHeaderComponent={content} ListFooterComponent={footer}
      renderItem={({ item }) => <KitchenRail title={item.name.split(' · ')[0]} kitchens={item.kitchens} {...rail} />}
      onEndReached={loadMore} onEndReachedThreshold={0.65}
      onLayout={event => setViewportHeight(event.nativeEvent.layout.height)}
      onContentSizeChange={(_width, height) => setContentHeight(height)}
      showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled"
      initialNumToRender={4} maxToRenderPerBatch={4} windowSize={5}
      contentContainerStyle={{ paddingHorizontal: width < 390 ? 14 : 18, paddingBottom: 110 }}
    />
  );
}

const maroon = '#5D100A';
const ink = '#25211F';
const muted = '#605751';
const normalizeQuery = (query: string) => Array.from(query.trim()).slice(0, 120).join('');
const styles = StyleSheet.create({
  search: { minHeight: 50, flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderColor: '#EDE5E0', borderRadius: 12, backgroundColor: '#FFF', paddingHorizontal: 14, marginBottom: 18 },
  input: { minWidth: 0, flex: 1, fontSize: 16, color: ink },
  empty: { marginBottom: 20 },
  heading: { color: ink, fontSize: 22, lineHeight: 27, fontWeight: '800', marginBottom: 10 },
  help: { color: muted, fontSize: 14 },
  meals: { marginBottom: 23 },
  mealRail: { gap: 12, paddingBottom: 3 },
  tile: { width: 156 },
  photo: { width: '100%', height: 98, overflow: 'hidden', backgroundColor: '#EDE5E0' },
  mealName: { color: ink, fontSize: 14, lineHeight: 18, fontWeight: '700', marginTop: 7 },
  kitchen: { color: muted, fontSize: 13, marginTop: 3 },
  price: { color: maroon, fontSize: 14, fontWeight: '700', marginTop: 3 },
  pressed: { opacity: 0.72 },
  footer: { paddingVertical: 16, alignItems: 'center' },
});
