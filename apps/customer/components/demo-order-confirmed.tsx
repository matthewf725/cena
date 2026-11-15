import { useEffect, useRef } from 'react';
import { Check } from 'lucide-react-native';
import { Animated, Easing, Platform, StyleSheet, View } from 'react-native';
import { headerTint } from './home-chrome';
import { Text } from './type';

export function DemoOrderConfirmed({ reduced, onDone }: { reduced: boolean; onDone: () => void }) {
  const progress = useRef(new Animated.Value(reduced ? 0.5 : 0)).current;
  const onDoneRef = useRef(onDone);
  const completed = useRef(false);
  onDoneRef.current = onDone;

  useEffect(() => {
    let active = true;
    const finish = () => {
      if (!active || completed.current) return;
      completed.current = true;
      onDoneRef.current();
    };

    if (reduced) {
      progress.setValue(0.5);
      const timer = setTimeout(finish, 800);
      return () => { active = false; clearTimeout(timer); };
    }

    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: 950,
      easing: Easing.linear,
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start(({ finished }) => { if (finished) finish(); });
    return () => { active = false; animation.stop(); };
  }, [progress, reduced]);

  const opacity = progress.interpolate({ inputRange: [0, 0.2, 0.8, 1], outputRange: [0, 1, 1, 0] });
  const scale = progress.interpolate({ inputRange: [0, 0.25, 0.45, 1], outputRange: [0.88, 1.045, 1, 1] });

  return <View style={styles.page} testID="demo-order-confirmed">
    <Animated.View style={[styles.message, { opacity, transform: [{ scale }] }]}
      role="status" accessibilityLiveRegion="polite">
      <View style={styles.seal} aria-hidden>
        <Check size={40} strokeWidth={2.5} color="#5D100A" />
      </View>
      <Text style={styles.title}>Order confirmed</Text>
    </Animated.View>
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, minHeight: 0, paddingHorizontal: 24, justifyContent: 'center', alignItems: 'center', backgroundColor: '#FAF6F3' },
  message: { alignItems: 'center', gap: 18 },
  seal: { width: 76, height: 76, borderRadius: 38, backgroundColor: headerTint, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: 26, lineHeight: 32, fontWeight: '600', color: '#271D19', textAlign: 'center' },
});
