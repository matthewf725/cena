import { useRef, useState } from 'react';
import { ImageBackground, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';
import type { Kitchen } from '../lib/data';
import { foodPhoto } from '../lib/food-photos';
import { PickupCountdown } from './pickup-countdown';

export function KitchenRail({ title, kitchens, width, radius, open, reduced }: {
  title: string;
  kitchens: Kitchen[];
  width: number;
  radius: number;
  open: (kitchen: Kitchen) => void;
  reduced: boolean;
}) {
  const rail = useRef<ScrollView>(null);
  const [offset, setOffset] = useState(0);
  if (!kitchens.length) return null;
  const cardWidth = Math.max(210, Math.min(320, width - (width < 390 ? 54 : 84)));
  const stride = cardWidth + 12;
  const end = Math.max(0, kitchens.length * stride - 12 - (width - (width < 390 ? 28 : 36)));
  const move = (direction: number) => rail.current?.scrollTo({
    x: Math.max(0, Math.min(end, offset + stride * direction)),
    animated: !reduced,
  });

  return (
    <View style={styles.section}>
      <View style={styles.heading}>
        <Text accessibilityRole="header" style={styles.title}>{title}</Text>
        {end > 0 && (
          <View style={styles.controls}>
            <Pressable accessibilityRole="button" accessibilityLabel="Previous kitchens" disabled={offset < 1}
              onPress={() => move(-1)} style={[styles.arrow, offset < 1 && styles.disabled]}>
              <ChevronLeft size={19} color="#5D100A" />
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="Next kitchens" disabled={offset >= end - 1}
              onPress={() => move(1)} style={[styles.arrow, offset >= end - 1 && styles.disabled]}>
              <ChevronRight size={19} color="#5D100A" />
            </Pressable>
          </View>
        )}
      </View>
      <ScrollView
        ref={rail}
        horizontal
        showsHorizontalScrollIndicator={false}
        decelerationRate={reduced ? 'normal' : 'fast'}
        snapToInterval={reduced ? undefined : stride}
        snapToAlignment="start"
        scrollEventThrottle={64}
        onScroll={event => setOffset(event.nativeEvent.contentOffset.x)}
        contentContainerStyle={styles.rail}
      >
        {kitchens.map(kitchen => (
          <View key={kitchen.id} style={[styles.card, { width: cardWidth }]}>
            <Pressable accessibilityRole="button" accessibilityLabel={`View ${kitchen.name} menu`} onPress={() => open(kitchen)}
              style={({ pressed }) => pressed && styles.pressed}>
              <ImageBackground source={foodPhoto(kitchen.image.startsWith('http') ? kitchen.id : kitchen.image)}
                resizeMode="cover" style={[styles.photo, { height: Math.round(cardWidth * 9 / 16), borderRadius: radius }]} />
              <View style={styles.caption}>
                <View style={styles.copy}>
                  <Text numberOfLines={1} style={styles.name}>{kitchen.name}</Text>
                  <Text numberOfLines={1} style={styles.details}>{kitchen.cuisine} · From ${Math.min(...kitchen.meals.map(meal => meal.price)).toFixed(2)}</Text>
                </View>
                <ChevronRight size={18} color="#5D100A" />
              </View>
            </Pressable>
            <PickupCountdown slots={kitchen.pickupSlots} timezone={kitchen.timezone} />
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginBottom: 22, minWidth: 0 },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 5, marginBottom: 5, minHeight: 44 },
  title: { color: '#25211F', fontSize: 22, lineHeight: 27, fontWeight: '800', flexShrink: 1 },
  controls: { flexDirection: 'row', gap: 2, flexShrink: 0 },
  arrow: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.32 },
  rail: { gap: 12, paddingBottom: 2 },
  card: { flexShrink: 0 },
  photo: { width: '100%', overflow: 'hidden', backgroundColor: '#EADAD2' },
  caption: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 8, paddingBottom: 9 },
  copy: { flex: 1, minWidth: 0 },
  name: { color: '#25211F', fontSize: 15, lineHeight: 19, fontWeight: '800' },
  details: { color: '#605751', fontSize: 13, lineHeight: 17, marginTop: 2 },
  pressed: { opacity: 0.72 },
});
