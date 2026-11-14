import { FlatList, ImageBackground, Pressable, StyleSheet, View } from 'react-native';
import { Text } from './type';
import type { Kitchen } from '../lib/data';
import { formatDistance } from '../lib/discovery';
import { foodPhoto } from '../lib/food-photos';
import { PickupCountdown } from './pickup-countdown';

export function KitchenRail({ title, kitchens, width, radius, open, reduced, fromCity }: {
  title: string;
  kitchens: Kitchen[];
  width: number;
  radius: number;
  open: (kitchen: Kitchen) => void;
  reduced: boolean;
  fromCity: boolean;
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
        renderItem={({ item: kitchen }) => (
          <View style={[styles.card, { width: cardWidth, borderRadius: radius }]}>
            <Pressable accessibilityRole="button" accessibilityLabel={`View ${kitchen.name} menu`} onPress={() => open(kitchen)}
              style={({ pressed }) => pressed && styles.pressed}>
              <ImageBackground source={foodPhoto(kitchen.image.startsWith('http') ? kitchen.id : kitchen.image)}
                resizeMode="cover" style={[styles.photo, { height: Math.round(cardWidth * 9 / 16) }]} />
              <View style={styles.caption}>
                <Text numberOfLines={1} style={styles.name}>{kitchen.name}</Text>
                <Text numberOfLines={1} style={styles.details}>{[formatDistance(kitchen.distanceMiles, fromCity), kitchen.cuisine].filter(Boolean).join(' · ')}</Text>
              </View>
            </Pressable>
            {kitchen.pickupSlots !== undefined && <View style={styles.countdown}>
              <PickupCountdown slots={kitchen.pickupSlots} timezone={kitchen.timezone} />
            </View>}
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 22, minWidth: 0 },
  title: { fontWeight:'500', color: '#271D19', fontSize: 25, lineHeight: 30, marginBottom: 10 },
  rail: { gap: 12, paddingBottom: 2 },
  card: { flexShrink: 0, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#E8DCD5', overflow: 'hidden' },
  photo: { width: '100%', overflow: 'hidden', backgroundColor: '#F0E1D9' },
  caption: { paddingTop: 10, paddingBottom: 10, paddingHorizontal: 12 },
  countdown: { paddingHorizontal: 12, paddingBottom: 12 },
  name: { fontWeight:'500', color: '#271D19', fontSize: 18, lineHeight: 23 },
  details: { color: '#77645B', fontSize: 14, lineHeight: 19, marginTop: 2 },
  pressed: { opacity: 0.72 },
});
