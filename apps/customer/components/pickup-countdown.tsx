import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Clock3 } from 'lucide-react-native';
import type { Kitchen } from '../lib/data';

export function PickupCountdown({ slots, timezone }: { slots: Kitchen['pickupSlots']; timezone?: string }) {
  const [now, setNow] = useState(Date.now);
  const upcoming = (slots ?? []).filter(slot => Date.parse(slot.cutoffAt) > now && Date.parse(slot.startsAt) > now);
  const next = upcoming[0];

  useEffect(() => {
    if (!next) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [next?.id]);

  if (!next) return <Text style={styles.unavailable}>No pickup windows available</Text>;

  const start = new Date(next.startsAt);
  const dayFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: timezone });
  const isToday = dayFormat.format(start) === dayFormat.format(now);
  const nextDay = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: timezone }).format(start);
  const seconds = Math.max(0, Math.ceil((Date.parse(next.cutoffAt) - now) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const clock = [hours, minutes, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
  const pickup = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: timezone }).format(start);

  return (
    <View style={styles.outline}>
      <Clock3 size={16} color={green} accessibilityElementsHidden importantForAccessibility="no" />
      <View style={styles.copy}>
        <Text style={styles.label}>{isToday ? 'Order cutoff today' : `Order cutoff for ${nextDay}`}</Text>
        <Text style={styles.pickup}>{isToday ? 'Today' : nextDay} at {pickup} pickup</Text>
      </View>
      <Text style={styles.counter} accessibilityRole="timer" accessibilityLabel={`${hours} hours, ${minutes} minutes to order`}>
        {clock}
      </Text>
    </View>
  );
}

const green = '#245C40';

const styles = StyleSheet.create({
  outline: { minHeight: 53, flexDirection: 'row', alignItems: 'center', gap: 7, borderWidth: 1, borderColor: green, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 7 },
  copy: { flex: 1, minWidth: 0 },
  label: { color: green, fontSize: 12, fontWeight: '700' },
  pickup: { color: green, fontSize: 11, marginTop: 2 },
  counter: { color: green, fontSize: 13, fontWeight: '800', fontVariant: ['tabular-nums'], flexShrink: 0 },
  unavailable: { color: '#605751', fontSize: 13 },
});
