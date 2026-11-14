import { FlatList, ImageBackground, Pressable, StyleSheet, View } from 'react-native';
import { Star } from 'lucide-react-native';
import { Text } from './type';
import type { Kitchen } from '../lib/data';
import { formatDistance } from '../lib/discovery';
import { restaurantPhoto, restaurantRating } from '../lib/restaurant-presentation';
import { PickupCountdown } from './pickup-countdown';

export function KitchenRail({ title, kitchens, width, radius, open, reduced, suspended }: {
  title: string;
  kitchens: Kitchen[];
  width: number;
  radius: number;
  open: (kitchen: Kitchen) => void;
  reduced: boolean;
  suspended: boolean;
}) {
  if (!kitchens.length) return null;
  const cardWidth = Math.max(210, Math.min(320, width - (width < 390 ? 54 : 84)));
  const stride = cardWidth + 12;

  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      <FlatList
        data={kitchens}
        horizontal
        keyExtractor={kitchen => kitchen.id}
        initialNumToRender={3}
        windowSize={3}
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        decelerationRate={reduced ? 'normal' : 'fast'}
        snapToInterval={reduced ? undefined : stride}
        snapToAlignment="start"
        contentContainerStyle={styles.rail}
        renderItem={({ item: kitchen }) => <KitchenCard kitchen={kitchen} width={cardWidth} radius={radius} open={open} suspended={suspended} />}
      />
    </View>
  );
}

export function KitchenCard({ kitchen, width, radius, open, suspended }: {
  kitchen: Kitchen;
  width: number;
  radius: number;
  open: (kitchen: Kitchen) => void;
  suspended: boolean;
}) {
  const rating = restaurantRating(kitchen);
  return <View style={[styles.card, { width, borderRadius: radius }]}>
    <Pressable accessibilityRole="button" accessibilityLabel={`View ${kitchen.name} menu`} onPress={() => open(kitchen)}
      style={({ pressed }) => pressed && styles.pressed}>
      <ImageBackground source={restaurantPhoto(kitchen)} resizeMode="cover"
        style={[styles.photo, { height: Math.min(300, Math.round(width * 9 / 16)) }]} />
      <View style={styles.caption}>
        <View style={styles.nameRow}>
          <Text numberOfLines={1} style={styles.name}>{kitchen.name}</Text>
          {rating && <View style={styles.rating}>
            <Star size={13} color="#9A5A2F" fill="#9A5A2F" aria-hidden />
            <Text accessibilityLabel={`${rating} out of 5 stars`} style={styles.ratingValue}>{rating}</Text>
          </View>}
        </View>
        <Text numberOfLines={1} style={styles.details}>{[formatDistance(kitchen.distanceMiles), kitchen.cuisine, kitchen.id.startsWith('cal-poly-') && 'Demo menu'].filter(Boolean).join(' · ')}</Text>
      </View>
    </Pressable>
    {kitchen.pickupSlots !== undefined && <View style={styles.countdown}>
      <PickupCountdown slots={kitchen.pickupSlots} timezone={kitchen.timezone} suspended={suspended} />
    </View>}
  </View>;
}

const styles = StyleSheet.create({
  section: { marginBottom: 22, minWidth: 0 },
  title: { fontWeight:'500', color: '#271D19', fontSize: 25, lineHeight: 30, marginBottom: 10 },
  rail: { gap: 12, paddingBottom: 2 },
  card: { flexShrink: 0, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E8DCD5', overflow: 'hidden' },
  photo: { width: '100%', overflow: 'hidden', backgroundColor: '#F0E1D9' },
  caption: { paddingTop: 10, paddingBottom: 10, paddingHorizontal: 12 },
  countdown: { paddingHorizontal: 12, paddingBottom: 12 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flex: 1, fontWeight:'500', color: '#271D19', fontSize: 18, lineHeight: 23 },
  rating: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  ratingValue: { color: '#271D19', fontSize: 14, fontWeight: '500' },
  details: { color: '#77645B', fontSize: 14, lineHeight: 19, marginTop: 2 },
  pressed: { opacity: 0.72 },
});
