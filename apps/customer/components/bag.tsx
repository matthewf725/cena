import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ChevronRight, Minus, Plus, ShoppingBag } from 'lucide-react-native';
import type { Meal } from '../lib/data';
import { foodPhoto } from '../lib/food-photos';

export type BagLine = { meal: Meal; qty: number; options: string; restaurantId: string };

export function Bag({ items, subtotal, radius, loading, bottomNavHeight = 0, change, remove, browse, checkout }: {
  items: BagLine[];
  subtotal: number;
  radius: number;
  loading: boolean;
  bottomNavHeight?: number;
  change: (id: string, delta: number) => void;
  remove: (id: string) => void;
  browse: () => void;
  checkout: () => void;
}) {
  return <View style={styles.page}>
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
      <Text accessibilityRole="header" style={styles.title}>Your bag</Text>
      {items.length ? items.map(({ meal, qty, options }) => (
        <View key={meal.id} style={[styles.card, { borderRadius: radius }]}>
          <View style={styles.row}>
            <Image source={foodPhoto(meal.image.startsWith('http') ? meal.id : meal.image)}
              style={[styles.photo, { borderRadius: radius - 4 }]} />
            <View style={styles.details}>
              <Text style={styles.item}>{meal.name}</Text>
              {!!options && <Text style={styles.secondary}>{options}</Text>}
              <Text style={styles.price}>${(meal.price * qty).toFixed(2)}</Text>
            </View>
          </View>
          <View style={[styles.row, styles.actions]}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${meal.name}`} onPress={() => remove(meal.id)}>
              <Text style={styles.remove}>Remove</Text>
            </Pressable>
            <View style={styles.stepper}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Decrease ${meal.name} quantity`}
                onPress={() => change(meal.id, -1)} style={styles.step}><Minus size={16} color={maroon} /></Pressable>
              <Text style={styles.quantity}>{qty}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={`Increase ${meal.name} quantity`} disabled={qty >= 50}
                onPress={() => change(meal.id, 1)} style={[styles.step, qty >= 50 && styles.disabled]}><Plus size={16} color={maroon} /></Pressable>
            </View>
          </View>
        </View>
      )) : <View style={[styles.empty, { borderRadius: radius }]}>
        <ShoppingBag color={maroon} size={30} />
        <Text style={styles.item}>Your bag is empty</Text>
        <Pressable accessibilityRole="button" onPress={browse} style={styles.button}>
          <Text style={styles.buttonText}>Browse meal kits</Text>
        </Pressable>
      </View>}
    </ScrollView>
    {!!items.length && <View style={[styles.footer, { marginBottom: bottomNavHeight }]}>
      <View style={[styles.row, styles.actions]}>
        <Text style={styles.item}>Subtotal</Text><Text style={styles.price}>${subtotal.toFixed(2)}</Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityState={{ busy: loading }} disabled={loading} onPress={checkout}
        style={[styles.button, styles.actions, loading && styles.disabled]}>
        <Text style={styles.buttonText}>{loading ? 'Checking availability…' : 'Continue to pickup'}</Text>
        <ChevronRight size={18} color="#FFF" />
      </Pressable>
    </View>}
  </View>;
}

const maroon = '#5D100A';
const styles = StyleSheet.create({
  page: { flex: 1, minHeight: 0 }, content: { padding: 18, gap: 12 },
  title: { fontSize: 27, fontWeight: '800', color: '#231F1C', marginBottom: 4 },
  card: { backgroundColor: '#FFF', borderWidth: 1, borderColor: '#EDE5E0', padding: 12, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 }, details: { flex: 1, minWidth: 0, gap: 3 },
  photo: { width: 59, height: 59, backgroundColor: '#EDE5E0' },
  item: { fontSize: 16, fontWeight: '700', color: '#231F1C' }, secondary: { fontSize: 13, color: '#605751' },
  price: { fontSize: 15, fontWeight: '800', color: maroon }, actions: { justifyContent: 'space-between' },
  stepper: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FAF6F3', borderRadius: 24 },
  step: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  quantity: { minWidth: 18, textAlign: 'center', color: maroon, fontWeight: '800' },
  remove: { color: maroon, fontSize: 13, paddingVertical: 12, fontWeight: '700' },
  empty: { minHeight: 190, backgroundColor: '#FFF', alignItems: 'center', justifyContent: 'center', padding: 18, gap: 16 },
  footer: { paddingHorizontal: 18, paddingVertical: 12, gap: 10, borderTopWidth: 1, borderTopColor: '#EDE5E0' },
  button: { backgroundColor: maroon, minHeight: 46, borderRadius: 16, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center' },
  buttonText: { color: '#FFF', fontSize: 15, fontWeight: '800', flexShrink: 1 }, disabled: { opacity: 0.55 },
});
