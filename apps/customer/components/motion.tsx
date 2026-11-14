import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

export function useReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    Platform.OS === 'web' && typeof matchMedia === 'function'
      ? matchMedia('(prefers-reduced-motion: reduce)').matches
      : true,
  );
  useEffect(() => {
    if (Platform.OS === 'web' && typeof matchMedia === 'function') {
      const query = matchMedia('(prefers-reduced-motion: reduce)');
      const update = () => setReduced(query.matches);
      update();
      query.addEventListener('change', update);
      return () => query.removeEventListener('change', update);
    }
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduced);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => subscription.remove();
  }, []);
  return reduced;
}

export function Enter({ children, reduced, distance = 8, style }: {
  children: ReactNode;
  reduced: boolean;
  distance?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const value = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  useEffect(() => {
    if (reduced) {
      value.setValue(1);
      return;
    }
    const animation = Animated.timing(value, {
      toValue: 1,
      duration: 210,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start();
    return () => animation.stop();
  }, [reduced, value]);

  return <Animated.View style={[styles.fill, style, {
    opacity: value,
    transform: [{ translateY: value.interpolate({ inputRange: [0, 1], outputRange: [distance, 0] }) }],
  }]}>{children}</Animated.View>;
}

const styles = StyleSheet.create({ fill: { flex: 1, minHeight: 0 } });
