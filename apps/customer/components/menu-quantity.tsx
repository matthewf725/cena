import { useEffect, useRef, useState } from 'react';
import { Animated, Platform, Pressable, StyleSheet, View } from 'react-native';
import { Minus, Plus } from 'lucide-react-native';
import { Text } from './type';

const maroon = '#46110E';
const hitSize = 44;
const expandedWidth = 88;

export function MenuQuantity({ name, count, reduced, disabled, needsOptions, onPlus, onMinus }: {
  name: string; count: number; reduced: boolean; disabled: boolean; needsOptions: boolean;
  onPlus: () => boolean; onMinus: () => void;
}) {
  const [shown, setShown] = useState(false);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) { progress.setValue(shown ? 1 : 0); return; }
    const animation = Animated.timing(progress, { toValue: shown ? 1 : 0, duration: 210, useNativeDriver: false });
    animation.start();
    return () => animation.stop();
  }, [shown, reduced, progress]);
  useEffect(() => () => { if (collapseTimer.current) clearTimeout(collapseTimer.current); }, []);

  function addOne() {
    const added = onPlus();
    if (!added) return;
    setShown(true);
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    collapseTimer.current = setTimeout(() => setShown(false), 950);
  }

  return <Animated.View style={[s.pill, { width: progress.interpolate({ inputRange: [0, 1], outputRange: [hitSize, expandedWidth] }) }]}>
    <Animated.View pointerEvents={shown ? 'auto' : 'none'} aria-hidden={!shown} style={[s.adjustment, { opacity: progress }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Remove one ${name}`} disabled={disabled || !shown || count === 0} onPress={onMinus} style={s.target}>
        <Minus size={18} color={count ? maroon : '#A5948C'} aria-hidden />
      </Pressable>
      <View pointerEvents="none" style={s.countPosition}><Text style={s.count}>{count}</Text></View>
    </Animated.View>
    <Pressable accessibilityRole="button" accessibilityLabel={needsOptions ? `Choose options for ${name}` : `Add one ${name} to bag`} disabled={disabled} onPress={addOne} style={s.plus}>
      <Plus size={19} color={maroon} aria-hidden />
    </Pressable>
  </Animated.View>;
}

export function useMenuTabOffset(shown: boolean, reduced: boolean, height: number) {
  const offset = useRef(new Animated.Value(shown ? 0 : 1)).current;
  useEffect(() => {
    if (reduced) { offset.setValue(shown ? 0 : 1); return; }
    const animation = Animated.timing(offset, { toValue: shown ? 0 : 1, duration: 220, useNativeDriver: Platform.OS !== 'web' });
    animation.start();
    return () => animation.stop();
  }, [shown, reduced, offset]);
  return offset.interpolate({ inputRange: [0, 1], outputRange: [0,height+4] });
}

const s = StyleSheet.create({
  pill: { position: 'absolute', right: 0, bottom: 0, height: hitSize, borderRadius: hitSize / 2, backgroundColor: '#FFFFFF', borderColor: '#E4D4CB', borderWidth: 1, overflow: 'hidden', justifyContent: 'center', elevation: 2 },
  adjustment: { position: 'absolute', left: 0, top: 0, height: hitSize - 2, flexDirection: 'row', alignItems: 'center' },
  target: { width: hitSize - 2, height: hitSize - 2, alignItems: 'center', justifyContent: 'center' },
  plus: { position: 'absolute', top: 0, right: 0, width: hitSize - 2, height: hitSize - 2, alignItems: 'center', justifyContent: 'center' },
  countPosition: { position: 'absolute', width: expandedWidth - 2, alignItems: 'center' },
  count: { color: maroon, fontSize: 14, fontWeight: '500', fontVariant: ['tabular-nums'] },
});
