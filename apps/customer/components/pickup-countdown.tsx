import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
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
    <View style={styles.outline}>
      <Clock3 size={16} color={green} accessibilityElementsHidden importantForAccessibility="no" />
      <Text style={styles.label}>Order cutoff for pickup today</Text>
      <Text style={styles.counter} accessibilityRole="timer" accessibilityLabel={`${hours} hours, ${minutes} minutes to order`}>
        {clock}
      </Text>
    </View>
  );
}

const green = '#245C40';

const styles = StyleSheet.create({
  outline: { minHeight: 38, flexDirection: 'row', alignItems: 'center', gap: 7, borderWidth: 1, borderColor: green, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 7 },
  label: { color: green, fontSize: 12, fontWeight: '700', flex: 1 },
  counter: { color: green, fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'], flexShrink: 0 },
  unavailable: { color: '#605751', fontSize: 13 },
});
