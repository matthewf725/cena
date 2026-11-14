import { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, Platform } from 'react-native';

export function useSlideUp(distance: number, reduced: boolean, initiallyHidden = false) {
  const value = useRef(new Animated.Value(initiallyHidden && !reduced ? distance : 0)).current;
  const running = useRef<Animated.CompositeAnimation | null>(null);
  const options = useRef({ distance, reduced });
  options.current = { distance, reduced };

  const slide = useMemo(() => {
    function stop() {
      const previous = running.current;
      running.current = null;
      previous?.stop();
    }

    function move(toValue: number, duration: number, easing: (value: number) => number, onFinish?: () => void) {
      stop();
      if (options.current.reduced) {
        value.setValue(toValue);
        onFinish?.();
        return;
      }
      const animation = Animated.timing(value, { toValue, duration, easing, useNativeDriver: Platform.OS !== 'web' });
      running.current = animation;
      animation.start(({ finished }) => {
        if (running.current !== animation) return;
        running.current = null;
        if (finished) onFinish?.();
      });
    }

    const settle = () => move(0, 275, Easing.out(Easing.cubic));
    return {
      value,
      stop,
      settle,
      present() {
        stop();
        value.setValue(options.current.reduced ? 0 : options.current.distance);
        settle();
      },
      drag(offset: number) {
        value.setValue(Math.max(0, Math.min(options.current.distance, offset)));
      },
      dismiss(onFinish: () => void) {
        move(options.current.distance, 210, Easing.in(Easing.quad), onFinish);
      },
      reset() {
        stop();
        value.setValue(0);
      },
    };
  }, [value]);

  useEffect(() => slide.stop, [slide]);
  return slide;
}
