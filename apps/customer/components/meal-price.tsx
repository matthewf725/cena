import { StyleSheet, View } from 'react-native';
import { Text } from './type';
import type { Meal } from '../lib/data';

export function MealPrice({ meal }: { meal: Meal }) {
  const comparison = meal.preparedMealTotalCents;
  return (
    <View style={styles.prices}>
      <Text style={styles.kit}>${meal.price.toFixed(2)}</Text>
      {comparison !== undefined && comparison > Math.round(meal.price * 100) && (
        <Text style={styles.label}>
          <Text style={styles.comparison}>${(comparison / 100).toFixed(2)}</Text> prepared (incl. tax)
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  prices: { gap: 3, marginTop: 5 },
  kit: { fontSize: 15, fontWeight: '500', color: '#5D100A' },
  label: { fontSize: 11, lineHeight: 15, color: '#77645B' },
  comparison: { textDecorationLine: 'line-through' },
});
