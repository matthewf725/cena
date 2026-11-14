import { Image, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Text } from './type';
import { ChevronRight, Minus, Plus, ShoppingBag } from 'lucide-react-native';
import type { Meal, MealSelections } from '../lib/data';
import { foodPhoto } from '../lib/food-photos';

export type BagLine = { meal: Meal; qty: number; options: string; restaurantId: string; selections?: MealSelections };

export function Bag({ items, subtotal, radius, loading, locked = false, bottomNavHeight = 0, change, remove, browse, addItems, checkout }: {
  items: (BagLine & { key: string })[];
  subtotal: number;
  radius: number;
  loading: boolean;
  locked?: boolean;
  bottomNavHeight?: number;
  change: (id: string, delta: number) => void;
  remove: (id: string) => void;
  browse: () => void;
  addItems: () => void;
  checkout: () => void;
}) {
  return <View style={styles.page}>
    <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>Your bag</Text>
        {!!items.length && <Pressable accessibilityRole="button" accessibilityLabel="Add items" disabled={locked} onPress={addItems}
          style={[styles.addItems, { borderRadius: radius }, locked && styles.disabled]}>
          <Plus size={17} color={maroon} />
          <Text style={styles.addItemsText}>Add items</Text>
        </Pressable>}
      </View>
      {items.length ? items.map(({ key, meal, qty, options }) => (
        <View key={key} style={[styles.card, { borderRadius: radius }]}>
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
            <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${meal.name}`} disabled={locked} onPress={() => remove(key)}>
              <Text style={styles.remove}>Remove</Text>
            </Pressable>
            <View style={styles.stepper}>
              <Pressable accessibilityRole="button" accessibilityLabel={`Decrease ${meal.name} quantity`} disabled={locked}
                onPress={() => change(key, -1)} style={styles.step}><Minus size={16} color={maroon} /></Pressable>
              <Text style={styles.quantity}>{qty}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={`Increase ${meal.name} quantity`} disabled={locked || qty >= 50}
                onPress={() => change(key, 1)} style={[styles.step, (locked || qty >= 50) && styles.disabled]}><Plus size={16} color={maroon} /></Pressable>
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
    <View style={[styles.footer, { marginBottom: bottomNavHeight }]}>
      <View style={[styles.row, styles.subtotalRow, { borderRadius: radius }]}>
        <Text style={styles.subtotalLabel}>Subtotal</Text>
        <Text style={styles.subtotalPrice}>${subtotal.toFixed(2)}</Text>
      </View>
      {!!items.length && <Pressable accessibilityRole="button" accessibilityState={{ busy: loading }} disabled={loading} onPress={checkout}
        style={[styles.button, styles.actions, loading && styles.disabled]}>
        <Text style={styles.buttonText}>{loading ? 'Checking availability…' : 'Continue to checkout'}</Text>
        <ChevronRight size={18} color="#FFF" />
      </Pressable>}
    </View>
  </View>;
}

const maroon = '#5D100A';
const styles = StyleSheet.create({
  page: { flex: 1, minHeight: 0 }, content: { padding: 18, gap: 12 },
  header: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 4 },
  title: { flex: 1, minWidth: 0, fontWeight: '500', fontSize: 27, color: '#271D19' },
  addItems: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: 12, borderWidth: 1, borderColor: '#DCCAC1', backgroundColor: '#FFFDFA' },
  addItemsText: { color: maroon, fontSize: 14, fontWeight: '500' },
  card: { backgroundColor: '#FFFDFA', borderWidth: 1, borderColor: '#E8DCD5', padding: 12, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 }, details: { flex: 1, minWidth: 0, gap: 3 },
  photo: { width: 59, height: 59, backgroundColor: '#E8DCD5' },
  item: { fontSize: 16, fontWeight: '500', color: '#271D19' }, secondary: { fontSize: 13, color: '#77645B' },
  price: { fontSize: 15, fontWeight: '500', color: maroon }, actions: { justifyContent: 'space-between' },
  stepper: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FAF6F3', borderRadius: 24 },
  step: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  quantity: { minWidth: 18, textAlign: 'center', color: maroon, fontWeight: '500' },
  remove: { color: maroon, fontSize: 13, paddingVertical: 12, fontWeight: '500' },
  empty: { minHeight: 190, backgroundColor: '#FFFDFA', alignItems: 'center', justifyContent: 'center', padding: 18, gap: 16 },
  subtotalRow: { minHeight: 54, justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 10, backgroundColor: '#FFF8F4', borderWidth: 1, borderColor: '#E8DCD5' },
  subtotalLabel: { fontSize: 15, fontWeight: '500', color: '#4A0D09' },
  subtotalPrice: { fontFamily: Platform.select({ ios: 'System', android: 'sans-serif', default: 'system-ui' }), fontSize: 17, fontWeight: '400', fontVariant: ['tabular-nums'], color: '#46110E' },
  footer: { paddingHorizontal: 18, paddingVertical: 12, gap: 10, borderTopWidth: 1, borderTopColor: '#E8DCD5' },
  button: { backgroundColor: maroon, minHeight: 46, borderRadius: 16, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center' },
  buttonText: { color: '#FFF', fontSize: 15, fontWeight: '500', flexShrink: 1 }, disabled: { opacity: 0.55 },
});
