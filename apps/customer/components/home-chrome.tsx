import { useEffect, useRef, useState, type ComponentRef, type ReactNode, type Ref } from 'react';
import { Animated, Platform, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { MapPin, Search, X } from 'lucide-react-native';
import { Text, TextInput } from './type';

export const searchGap = 12;
export const homeContentMaxWidth = 760;

const maroon = '#46110E';
const muted = '#77645B';
const greetingFont = Platform.select({ ios: 'System', android: 'sans-serif', default: 'system-ui' });
const controlSize = 44;

function gradient(image: string) {
  return Platform.OS === 'web' ? { backgroundImage: image } as ViewStyle : { experimental_backgroundImage: image };
}

const warmSurface = gradient('linear-gradient(180deg, #FFE1D5 0%, #FFE1D5 58%, rgba(255,225,213,.72) 76%, rgba(255,225,213,0) 100%)');

export function PageHeader({ children, identityHeight, topInset, expanded = false, reduced = true }: {
  children: ReactNode;
  identityHeight: number;
  topInset: number;
  expanded?: boolean;
  reduced?: boolean;
}) {
  const extra = useRef(new Animated.Value(expanded ? 72 : 0)).current;
  useEffect(() => {
    const toValue = expanded ? 72 : 0;
    if (reduced) { extra.setValue(toValue); return; }
    const animation = Animated.timing(extra, { toValue, duration: 240, useNativeDriver: false });
    animation.start();
    return () => animation.stop();
  }, [expanded, extra, reduced]);

  return <View pointerEvents="box-none" style={{ minHeight: identityHeight + 12 }}>
    <Animated.View pointerEvents="none" style={[s.surface, warmSurface, {
      top: -topInset, height: Animated.add(extra, identityHeight + topInset + 12),
    }]} />
    {children}
  </View>;
}

export function HomeWelcome({ greeting }: { greeting: string }) {
  return <Text accessibilityRole="header" numberOfLines={1} style={s.greeting}>{greeting}</Text>;
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
        <X size={18} color={maroon} aria-hidden />
      </Pressable>}
    </View>
  </View>;
}

const s = StyleSheet.create({
  surface: { position: 'absolute', left: 0, right: 0 },
  wordmark: { marginRight: 'auto' },
  greeting: { color: maroon, fontFamily: greetingFont, fontSize: 32, fontWeight: '400', lineHeight: 42, includeFontPadding: false, letterSpacing: -0.7, marginTop: 16, marginBottom: 24 },
  pressTarget: { flexShrink: 0 },
  control: { backgroundColor: '#FFFFFF', borderRadius: controlSize / 2, minWidth: controlSize, height: controlSize, paddingHorizontal: 12, justifyContent: 'center', alignItems: 'center', flexDirection: 'row' },
  pickupLabelClip: { overflow: 'hidden' },
  pickupLabel: { color: maroon, fontSize: 14, marginLeft: 7, lineHeight: 20 },
  searchDock: { position: 'absolute', alignItems: 'center', zIndex: 1 },
  search: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 9, borderWidth: 1, borderColor: '#DCCAC1', backgroundColor: '#FFFFFF', paddingLeft: 13, paddingRight: 4, boxShadow: '0 4px 16px rgba(39,29,25,.10)' },
  searchFocused: { borderColor: '#A46E64' },
  input: { minWidth: 0, flex: 1, height: '100%', fontSize: 16, color: '#271D19', paddingRight: 8, ...(Platform.OS==='web'?{outlineWidth:0}:{}) },
  clear: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
