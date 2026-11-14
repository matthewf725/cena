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
      <Clock3 size={16} color={green} aria-hidden={Platform.OS==='web'?true:undefined}
        {...(Platform.OS==='web'?{}:{accessibilityElementsHidden:true,importantForAccessibility:'no'})} />
      <Text style={styles.label}>Order cutoff for pickup today</Text>
      <Text style={styles.counter} accessibilityRole="timer" accessibilityLabel={`${hours} hours, ${minutes} minutes to order`}>
        {clock}
      </Text>
    </View>
  );
}

const green = '#245C40';
const lineHeight = 18;

const styles = StyleSheet.create({
  row: { minHeight: 28, flexDirection: 'row', alignItems: 'center', gap: 7 },
  label: { color: green, fontSize: 13, lineHeight, includeFontPadding: false, flex: 1 },
  counter: { color: green, fontSize: 14, lineHeight, includeFontPadding: false, fontWeight: '500', fontVariant: ['tabular-nums'], minWidth: 64, textAlign: 'right', flexShrink: 0 },
  unavailable: { color: '#77645B', fontSize: 14 },
});
