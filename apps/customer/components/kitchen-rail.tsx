import { FlatList, ImageBackground, Pressable, StyleSheet, Text, View } from 'react-native';
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
        decelerationRate={reduced ? 'normal' : 'fast'}
        snapToInterval={reduced ? undefined : stride}
        snapToAlignment="start"
        contentContainerStyle={styles.rail}
        renderItem={({ item: kitchen }) => (
          <View style={[styles.card, { width: cardWidth }]}>
            <Pressable accessibilityRole="button" accessibilityLabel={`View ${kitchen.name} menu`} onPress={() => open(kitchen)}
              style={({ pressed }) => pressed && styles.pressed}>
              <ImageBackground source={foodPhoto(kitchen.image.startsWith('http') ? kitchen.id : kitchen.image)}
                resizeMode="cover" style={[styles.photo, { height: Math.round(cardWidth * 9 / 16), borderRadius: radius }]} />
              <View style={styles.caption}>
                <Text numberOfLines={1} style={styles.name}>{kitchen.name}</Text>
                <Text numberOfLines={1} style={styles.details}>{[formatDistance(kitchen.distanceMiles, fromCity), kitchen.cuisine].filter(Boolean).join(' · ')}</Text>
              </View>
            </Pressable>
            {kitchen.pickupSlots !== undefined && <PickupCountdown slots={kitchen.pickupSlots} timezone={kitchen.timezone} />}
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 22, minWidth: 0 },
  title: { color: '#271D19', fontSize: 22, lineHeight: 27, fontWeight: '800', marginBottom: 10 },
  rail: { gap: 12, paddingBottom: 2 },
  card: { flexShrink: 0 },
  photo: { width: '100%', overflow: 'hidden', backgroundColor: '#F0E1D9' },
  caption: { paddingTop: 8, paddingBottom: 9 },
  name: { color: '#271D19', fontSize: 15, lineHeight: 19, fontWeight: '800' },
  details: { color: '#77645B', fontSize: 13, lineHeight: 17, marginTop: 2 },
  pressed: { opacity: 0.72 },
});
