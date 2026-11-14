import { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Text } from './type';
import { Clock3 } from 'lucide-react-native';
import type { Kitchen } from '../lib/data';

export function PickupCountdown({ slots, timezone }: { slots: Kitchen['pickupSlots']; timezone?: string }) {
  const [now, setNow] = useState(Date.now);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, dateStyle: 'short' });
  const today = day.format(now);
  const upcoming = (slots ?? []).filter(slot => Date.parse(slot.cutoffAt) > now && Date.parse(slot.startsAt) > now);
  const next = upcoming.find(slot => day.format(new Date(slot.startsAt)) === today);

  useEffect(() => {
    if (!next) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [next?.id]);

  if (!next) return <Text style={styles.unavailable}>{upcoming.length ? 'Order ahead for pickup' : 'No pickup windows available'}</Text>;

  const seconds = Math.max(0, Math.ceil((Date.parse(next.cutoffAt) - now) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const clock = [hours, minutes, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');

  return (
    <View style={styles.row}>
      <View style={styles.clock} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <Clock3 size={16} color={green} />
      </View>
      <Text style={styles.label}>Order cutoff for pickup today</Text>
      <Text style={styles.counter} accessibilityRole="timer" accessibilityLabel={`${hours} hours, ${minutes} minutes to order`}>
        {clock}
      </Text>
    </View>
  );
}

const green = '#245C40';
const textStyle = {
  color: green, fontFamily: Platform.select({ ios: 'System', android: 'sans-serif', default: 'system-ui' }),
  fontSize: 13, lineHeight: 20, fontWeight: '400', includeFontPadding: false,
} as const;

const styles = StyleSheet.create({
  row: { minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: 7 },
  clock: { width: 16, height: 20, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  label: { ...textStyle, flex: 1 },
  counter: { ...textStyle, fontVariant: ['tabular-nums'], minWidth: 60, textAlign: 'right', flexShrink: 0 },
  unavailable: { color: '#77645B', fontSize: 14 },
});
