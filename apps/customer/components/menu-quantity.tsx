import { useEffect, useRef } from 'react';
import { Animated, Platform, Pressable, StyleSheet } from 'react-native';
import { Minus, Plus } from 'lucide-react-native';
import { Text } from './type';

const maroon = '#46110E';
const hitSize = 44;

export function MenuQuantity({ name, count, expanded, reduced, disabled, onPlus, onMinus }: {
  name: string; count: number; expanded: boolean; reduced: boolean; disabled: boolean;
  onPlus: () => void; onMinus: () => void;
}) {
  const shown = expanded || count > 0;
  const progress = useRef(new Animated.Value(shown ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) { progress.setValue(shown ? 1 : 0); return; }
    const animation = Animated.timing(progress, { toValue: shown ? 1 : 0, duration: 210, useNativeDriver: false });
    animation.start();
    return () => animation.stop();
  }, [shown, reduced, progress]);

  return <Animated.View style={[s.pill, { width: progress.interpolate({ inputRange: [0, 1], outputRange: [hitSize, 116] }) }]}>
    <Animated.View pointerEvents={shown ? 'auto' : 'none'} aria-hidden={!shown} style={[s.adjustment, { opacity: progress }]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Remove one ${name}`} disabled={disabled || !shown || count === 0} onPress={onMinus} style={s.target}>
        <Minus size={18} color={count ? maroon : '#A5948C'} aria-hidden />
      </Pressable>
      <Text style={s.count}>{count}</Text>
    </Animated.View>
    <Pressable accessibilityRole="button" accessibilityLabel={`Choose options for ${name}`} disabled={disabled} onPress={onPlus} style={s.plus}>
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
  pill: { position: 'absolute', right: -4, bottom: -4, height: hitSize, borderRadius: hitSize / 2, backgroundColor: '#FFFFFF', borderColor: '#E4D4CB', borderWidth: 1, overflow: 'hidden', justifyContent: 'center', elevation: 2 },
  adjustment: { position: 'absolute', left: 0, top: 0, height: hitSize - 2, flexDirection: 'row', alignItems: 'center' },
  target: { width: hitSize - 2, height: hitSize - 2, alignItems: 'center', justifyContent: 'center' },
  plus: { position: 'absolute', top: 0, right: 0, width: hitSize - 2, height: hitSize - 2, alignItems: 'center', justifyContent: 'center' },
  count: { width: 28, color: maroon, textAlign: 'center', fontSize: 15, fontWeight: '500' },
});
