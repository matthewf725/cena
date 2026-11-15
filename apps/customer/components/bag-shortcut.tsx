import { ChevronRight } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from './type';

export const bagShortcutHeight = 53;

export function BagShortcut({ count, subtotal, onPress }: {
  count: number;
  subtotal: number;
  onPress: () => void;
}) {
  return <Pressable style={styles.bar} accessibilityRole="button" accessibilityLabel="View bag"
    accessibilityHint={`${count} ${count === 1 ? 'item' : 'items'}, $${subtotal.toFixed(2)} subtotal`} onPress={onPress}>
    <View style={styles.count}><Text style={styles.countText}>{count}</Text></View>
    <Text style={styles.label}>View bag</Text>
    <Text style={styles.subtotal}>${subtotal.toFixed(2)}</Text>
    <ChevronRight size={18} color="#FFF" aria-hidden />
  </Pressable>;
}

const maroon = '#5D100A';
const styles = StyleSheet.create({
  bar: { height: bagShortcutHeight, borderRadius: 12, backgroundColor: maroon, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10, elevation: 4 },
  count: { minWidth: 23, height: 23, paddingHorizontal: 5, borderRadius: 12, backgroundColor: '#FFFDFA', alignItems: 'center', justifyContent: 'center' },
  countText: { fontSize: 11, fontWeight: '500', color: maroon },
  label: { flex: 1, fontSize: 13, fontWeight: '500', color: '#FFF' },
  subtotal: { fontSize: 13, fontWeight: '500', color: '#FFF' },
});
