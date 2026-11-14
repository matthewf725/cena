import { useEffect, useId, useRef, useState, type ComponentRef, type ReactNode, type Ref } from 'react';
import { Animated, Platform, Pressable, StyleSheet, View } from 'react-native';
import { MapPin, Search, X } from 'lucide-react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { Text, TextInput } from './type';

export const searchGap = 12;
export const homeContentMaxWidth = 760;
export const headerContentGap = 12;

const maroon = '#46110E';
const muted = '#77645B';
const controlSize = 44;
const headerTint = '#FFE1D5';

export function PageHeader({ children, identityHeight, topInset, overlay = false }: {
  children: ReactNode;
  identityHeight: number;
  topInset: number;
  overlay?: boolean;
}) {
  const tintId = useId();
  const barHeight = identityHeight + topInset;
  const fadeHeight = barHeight + 32;
  return <View pointerEvents="box-none" style={[s.header,
    overlay ? s.headerOverlay : { minHeight: identityHeight + headerContentGap },
  ]}>
    <View pointerEvents="none" aria-hidden style={[s.surface, { top: -topInset, height: fadeHeight }]}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={tintId} x1="0%" y1="0%" x2="0%" y2="100%">
            <Stop offset={0} stopColor={headerTint} />
            <Stop offset={(barHeight - 14) / fadeHeight} stopColor={headerTint} />
            <Stop offset={(barHeight + 7) / fadeHeight} stopColor={headerTint} stopOpacity={0.38} />
            <Stop offset={1} stopColor={headerTint} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${tintId})`} />
      </Svg>
    </View>
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
  useEffect(() => {
    const toValue = compact ? 0 : 1;
    if (reduced) { progress.setValue(toValue); return; }
    const animation = Animated.timing(progress, { toValue, duration: 240, useNativeDriver: false });
    animation.start();
    return () => animation.stop();
  }, [compact, progress, reduced]);

  return <HeaderButton ref={ref} label={`Change pickup area, ${label}`} onPress={onPress} reduced={reduced}>
    <MapPin size={19} color={maroon} aria-hidden />
    <Animated.View aria-hidden style={[s.pickupLabelClip, {
      maxWidth: progress.interpolate({ inputRange: [0, 1], outputRange: [0, labelWidth] }),
      opacity: progress,
    }]}>
      <Text numberOfLines={1} style={s.pickupLabel}>{label}</Text>
    </Animated.View>
  </HeaderButton>;
}

export function HomeSearch({ query, setQuery, bottom, radius, side, height }: {
  query: string;
  setQuery: (value: string) => void;
  bottom: number;
  radius: number;
  side: number;
  height: number;
}) {
  const [focused,setFocused] = useState(false);
  return <View pointerEvents="box-none" style={[s.searchDock, { bottom, left: side, right: side }]}>
    <View style={[s.search, { borderRadius: radius, height }, focused && s.searchFocused]}>
      <Search size={18} color={maroon} aria-hidden />
      <TextInput accessibilityLabel="Search restaurants" value={query} onChangeText={setQuery}
        placeholder="Search restaurants" placeholderTextColor={muted} style={s.input} maxLength={120}
        onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)}
        autoCorrect={false} returnKeyType="search" clearButtonMode="never" />
      {!!query && <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setQuery('')} style={s.clear}>
        <View pointerEvents="none" style={s.clearCircle}><X size={18} color={maroon} aria-hidden /></View>
      </Pressable>}
    </View>
  </View>;
}

const s = StyleSheet.create({
  header: { zIndex: 1, overflow: 'visible' },
  headerOverlay: { position: 'absolute', top: 0, left: 0, right: 0 },
  surface: { position: 'absolute', left: 0, right: 0 },
  wordmark: { marginRight: 'auto' },
  pressTarget: { flexShrink: 0 },
  control: { backgroundColor: '#FFFFFF', borderRadius: controlSize / 2, minWidth: controlSize, height: controlSize, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'center', flexDirection: 'row' },
  pickupLabelClip: { overflow: 'hidden' },
  pickupLabel: { color: maroon, fontSize: 14, marginLeft: 7, lineHeight: 20 },
  searchDock: { position: 'absolute', alignItems: 'center', zIndex: 1 },
  search: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 9, borderWidth: 1, borderColor: '#DCCAC1', backgroundColor: '#FFFFFF', paddingLeft: 13, paddingRight: 4, boxShadow: '0 4px 16px rgba(39,29,25,.10)' },
  searchFocused: { borderColor: '#A46E64' },
  input: { minWidth: 0, flex: 1, height: '100%', fontSize: 16, color: '#271D19', paddingRight: 8, ...(Platform.OS==='web'?{outlineWidth:0,outlineColor:'transparent',boxShadow:'none',borderWidth:0}:{}) },
  clear: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  clearCircle: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#FAF6F3', alignItems: 'center', justifyContent: 'center' },
});
