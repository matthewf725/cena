import { useCallback, useEffect, useRef, useState, type ComponentRef, type ReactNode, type Ref } from 'react';
import { Animated, Easing, Keyboard, Platform, Pressable, StyleSheet, useWindowDimensions, View, type KeyboardEvent } from 'react-native';
import { MapPin, Search, X } from 'lucide-react-native';
import { Text, TextInput } from './type';

export const searchGap = 12;
export const homeContentMaxWidth = 760;
export const headerContentGap = 12;
export const headerTint = '#FFE1D5';

const maroon = '#46110E';
const muted = '#77645B';
const controlSize = 44;

export function PageHeader({ children, identityHeight, topInset, overlay = false }: {
  children: ReactNode;
  identityHeight: number;
  topInset: number;
  overlay?: boolean;
}) {
  const height = identityHeight + headerContentGap;
  return <View pointerEvents="box-none" style={[s.header,
    overlay ? s.headerOverlay : { minHeight: height },
  ]}>
    <View pointerEvents="none" aria-hidden style={[s.surface, { top: -topInset, height: height + topInset }]} />
    {children}
  </View>;
}

export function HeaderWordmark({ children }: {
  children: ReactNode;
}) {
  return <View pointerEvents="none" style={s.wordmark}>{children}</View>;
}

export function HeaderButton({ ref, label, onPress, children, reduced }: {
  ref?: Ref<ComponentRef<typeof Pressable>>;
  label: string;
  onPress: () => void;
  children: ReactNode;
  reduced: boolean;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (reduced) scale.setValue(1);
    return () => scale.stopAnimation();
  }, [reduced, scale]);

  const press = (toValue: number) => {
    if (reduced) return;
    Animated.timing(scale, { toValue, duration: 130, useNativeDriver: Platform.OS !== 'web' }).start();
  };

  return <Pressable ref={ref} accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
    onPressIn={() => press(0.92)} onPressOut={() => press(1)} style={s.pressTarget}>
    <Animated.View style={[s.control, { transform: [{ scale }] }]}>{children}</Animated.View>
  </Pressable>;
}

export function PickupAreaButton({ ref, label, compact, labelWidth, reduced, onPress }: {
  ref?: Ref<ComponentRef<typeof Pressable>>;
  label: string;
  compact: boolean;
  labelWidth: number;
  reduced: boolean;
  onPress: () => void;
}) {
  const progress = useRef(new Animated.Value(compact ? 0 : 1)).current;
  const [measuredLabelWidth, setMeasuredLabelWidth] = useState(0);
  const [pressed, setPressed] = useState(false);
  const width = Math.min(labelWidth, measuredLabelWidth + 7);
  useEffect(() => {
    const toValue = compact ? 0 : 1;
    if (reduced) { progress.setValue(toValue); return; }
    const animation = Animated.timing(progress, { toValue, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== 'web' });
    animation.start();
    return () => animation.stop();
  }, [compact, progress, reduced]);

  const shift = progress.interpolate({ inputRange: [0, 1], outputRange: [width, 0] });
  const backgroundColor = pressed ? '#F4E8E2' : '#FFFFFF';
  return <View pointerEvents="box-none" style={[s.pickupTarget, { width: controlSize + width }]}>
    <View pointerEvents="none" style={[s.pickupEndCap, { backgroundColor }]} />
    {/* The moving fill ends at the fixed cap's center, so its edge stays round as the pin slides. */}
    <View pointerEvents="none" style={s.pickupFillClip}>
      <Animated.View style={[s.pickupFill, { width: controlSize + width, backgroundColor, transform: [{ translateX: shift }] }]} />
    </View>
    <Animated.View pointerEvents="box-none" style={[s.pickupPill, { width: controlSize + width, transform: [{ translateX: shift }] }]}>
      <Pressable ref={ref} accessibilityRole="button" accessibilityLabel={`Change pickup area, ${label}`}
        onPress={onPress} onPressIn={() => setPressed(true)} onPressOut={() => setPressed(false)} style={s.pickupSurface}>
        <View pointerEvents="none" style={s.pickupIcon}><MapPin size={19} color={maroon} aria-hidden /></View>
        <Animated.View pointerEvents="none" aria-hidden style={[s.pickupLabelClip, { width, opacity: progress }]}>
          <Text numberOfLines={1} style={s.pickupLabel}>{label}</Text>
        </Animated.View>
      </Pressable>
    </Animated.View>
    <View pointerEvents="none" aria-hidden style={s.pickupMeasure}>
      <Text style={s.pickupMeasureText} numberOfLines={1} onLayout={event => setMeasuredLabelWidth(event.nativeEvent.layout.width)}>{label}</Text>
    </View>
  </View>;
}

export function HomeSearch({ query, setQuery, bottom, radius, side, height }: {
  query: string;
  setQuery: (value: string) => void;
  bottom: number;
  radius: number;
  side: number;
  height: number;
}) {
  const [focused, setFocused] = useState(false);
  const isFocused = useRef(false);
  const { height: windowHeight } = useWindowDimensions();
  const focusHeight = useRef(windowHeight);
  const geometry = useRef({ windowHeight, bottom });
  geometry.current = { windowHeight, bottom };
  const keyboardFrame = useRef<KeyboardEvent['endCoordinates'] | undefined>(undefined);
  const [keyboardInset, setKeyboardInset] = useState(0);
  const lift = useRef(new Animated.Value(0)).current;
  const dockBottom = keyboardInset > 0 ? Math.max(bottom, keyboardInset + searchGap) : bottom;

  const syncNativeDock = useCallback(() => {
    const frame = isFocused.current ? keyboardFrame.current : undefined;
    const { windowHeight, bottom } = geometry.current;
    if (Platform.OS === 'ios') {
      const inset = frame?.height ? Math.max(0, windowHeight - frame.screenY) : 0;
      lift.setValue(inset > 0 ? Math.min(0, bottom - inset - searchGap) : 0);
      return;
    }
    const layoutResize = Math.max(0, focusHeight.current - windowHeight);
    setKeyboardInset(frame ? Math.max(0, frame.height - layoutResize) : 0);
  }, [lift]);

  const syncWebDock = useCallback(() => {
    if (!isFocused.current || typeof window === 'undefined') return;
    const viewport = window.visualViewport;
    const layoutHeight = window.innerHeight;
    const visibleHeight = viewport?.height ?? layoutHeight;
    setKeyboardInset(Math.max(0, layoutHeight - visibleHeight - (viewport?.offsetTop ?? 0)));
  }, []);

  useEffect(() => {
    if (Platform.OS === 'web') {
      if (typeof window === 'undefined') return;
      const viewport = window.visualViewport;
      viewport?.addEventListener('resize', syncWebDock);
      viewport?.addEventListener('scroll', syncWebDock);
      window.addEventListener('resize', syncWebDock);
      return () => {
        viewport?.removeEventListener('resize', syncWebDock);
        viewport?.removeEventListener('scroll', syncWebDock);
        window.removeEventListener('resize', syncWebDock);
      };
    }
    const move = (event: KeyboardEvent) => {
      keyboardFrame.current = event.endCoordinates;
      syncNativeDock();
    };
    const hide = () => {
      keyboardFrame.current = undefined;
      syncNativeDock();
    };
    const listeners = [Keyboard.addListener('keyboardDidShow', move), Keyboard.addListener('keyboardDidHide', hide)];
    if (Platform.OS === 'ios') {
      // Subscribe before text focus so the first keyboard notification can dock the bar.
      listeners.push(Keyboard.addListener('keyboardWillShow', move), Keyboard.addListener('keyboardWillChangeFrame', move));
    }
    return () => listeners.forEach(listener => listener.remove());
  }, [syncNativeDock, syncWebDock]);

  useEffect(() => {
    if (Platform.OS !== 'web' && isFocused.current) syncNativeDock();
  }, [windowHeight, bottom, syncNativeDock]);

  function handleFocus() {
    isFocused.current = true;
    focusHeight.current = geometry.current.windowHeight;
    setFocused(true);
    if (Platform.OS === 'web') syncWebDock();
    else {
      keyboardFrame.current ??= Keyboard.metrics();
      syncNativeDock();
    }
  }

  function handleBlur() {
    isFocused.current = false;
    setFocused(false);
    if (Platform.OS === 'web') setKeyboardInset(0);
    else syncNativeDock();
  }

  return <Animated.View pointerEvents="box-none" style={[s.searchDock, { left: side, right: side },
    Platform.OS === 'ios' ? { bottom, transform: [{ translateY: lift }] } : { bottom: dockBottom }]}>
    <View style={[s.search, { borderRadius: radius, height }, focused && s.searchFocused]}>
      <Search size={18} color={maroon} aria-hidden />
      <TextInput accessibilityLabel="Search restaurants" value={query} onChangeText={setQuery}
        placeholder="Search restaurants" placeholderTextColor={muted} style={s.input} maxLength={120}
        onFocus={handleFocus} onBlur={handleBlur}
        autoCorrect={false} returnKeyType="search" clearButtonMode="never" />
      {!!query && <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setQuery('')} style={s.clear}>
        <View pointerEvents="none" style={s.clearCircle}><X size={18} color={maroon} aria-hidden /></View>
      </Pressable>}
    </View>
  </Animated.View>;
}

const s = StyleSheet.create({
  header: { zIndex: 1, overflow: 'visible' },
  headerOverlay: { position: 'absolute', top: 0, left: 0, right: 0 },
  surface: { position: 'absolute', left: 0, right: 0, backgroundColor: headerTint },
  wordmark: { marginRight: 'auto' },
  pressTarget: { flexShrink: 0 },
  control: { backgroundColor: '#FFFFFF', borderRadius: controlSize / 2, minWidth: controlSize, height: controlSize, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'center', flexDirection: 'row' },
  pickupTarget: { height: controlSize, flexShrink: 0, position: 'relative', overflow: 'hidden' },
  pickupEndCap: { position: 'absolute', right: 0, width: controlSize, height: controlSize, borderRadius: controlSize / 2 },
  pickupFillClip: { position: 'absolute', left: 0, right: controlSize / 2, top: 0, height: controlSize, overflow: 'hidden' },
  pickupFill: { height: controlSize, borderTopLeftRadius: controlSize / 2, borderBottomLeftRadius: controlSize / 2 },
  pickupPill: { position: 'absolute', right: 0, top: 0, height: controlSize },
  pickupSurface: { flex: 1 },
  pickupIcon: { position: 'absolute', left: 12, top: 12.5 },
  pickupLabelClip: { position: 'absolute', left: 31, top: 12, overflow: 'hidden' },
  pickupLabel: { color: maroon, fontSize: 14, marginLeft: 7, lineHeight: 20 },
  pickupMeasure: { position: 'absolute', opacity: 0 },
  pickupMeasureText: { fontSize: 14, lineHeight: 20 },
  searchDock: { position: 'absolute', alignItems: 'center', zIndex: 1 },
  search: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 9, borderWidth: 1, borderColor: '#DCCAC1', backgroundColor: '#FFFFFF', paddingLeft: 13, paddingRight: 4, boxShadow: '0 4px 16px rgba(39,29,25,.10)' },
  searchFocused: { borderColor: '#A46E64' },
  input: { minWidth: 0, flex: 1, height: '100%', fontSize: 16, color: '#271D19', paddingRight: 8, ...(Platform.OS==='web'?{outlineWidth:0,outlineColor:'transparent',boxShadow:'none',borderWidth:0}:{}) },
  clear: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  clearCircle: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#FAF6F3', alignItems: 'center', justifyContent: 'center' },
});
