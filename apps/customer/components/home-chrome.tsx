import type { ReactNode } from 'react';
import { Animated, Platform, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { Search, X } from 'lucide-react-native';
import { Text, TextInput, sans } from './type';

export const welcomeHeight = 60;
export const searchGap = 12;
export const homeContentMaxWidth = 760;

const maroon = '#5D100A';
const muted = '#77645B';
const fade = 'linear-gradient(180deg, #000 0%, #000 28%, transparent 100%)';
const blur = Platform.select<ViewStyle>({ web: {
  backdropFilter: 'blur(14px)',
  WebkitBackdropFilter: 'blur(14px)',
  maskImage: fade,
  WebkitMaskImage: fade,
} as ViewStyle });

function gradient(color: string) {
  const image = `linear-gradient(180deg, rgb(${color}) 0%, rgba(${color}, .96) 33%, rgba(${color}, .57) 70%, rgba(${color}, 0) 100%)`;
  return Platform.OS === 'web' ? { backgroundImage: image } as ViewStyle : { experimental_backgroundImage: image };
}

const compactGradient = gradient('250, 246, 243');
const expandedGradient = gradient('255, 225, 213');

export function HomeWelcome({ greeting }: { greeting: string }) {
  return <Text accessibilityRole="header" numberOfLines={1} style={s.staticGreeting}>{greeting}</Text>;
}

export function HomeHeader({ children, scrollY, reduced, greeting, collapsed, side, identityHeight, topInset }: {
  children: ReactNode;
  scrollY: Animated.Value;
  reduced: boolean;
  greeting: string;
  collapsed: boolean;
  side: number;
  identityHeight: number;
  topInset: number;
}) {
  const collapse = (start: number, end: number) => scrollY.interpolate({
    inputRange: [0, welcomeHeight], outputRange: [start, end], extrapolate: 'clamp',
  });

  return <View pointerEvents="box-none" style={s.header}>
    <Animated.View pointerEvents="none" style={[s.headerSurface, { top: -topInset }, blur, compactGradient, {
      height: reduced ? identityHeight + topInset : collapse(identityHeight + welcomeHeight + topInset, identityHeight + topInset),
    }]}>
      <Animated.View style={[StyleSheet.absoluteFillObject, expandedGradient, { opacity: reduced ? 1 : collapse(1, 0) }]} />
    </Animated.View>
    {children}
    {!reduced && <Animated.View pointerEvents="none" aria-hidden={collapsed}
      accessibilityElementsHidden={collapsed} importantForAccessibility={collapsed ? 'no-hide-descendants' : 'auto'}
      style={[s.welcome, { height: collapse(welcomeHeight, 0), paddingHorizontal: side }]}>
      <Animated.Text accessibilityRole="header" numberOfLines={1} style={[s.greeting, {
        opacity: collapse(1, 0), fontSize: collapse(32, 22), transform: [{ translateY: collapse(0, -14) }],
      }]}>{greeting}</Animated.Text>
    </Animated.View>}
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
  return <View pointerEvents="box-none" style={[s.searchDock, { bottom, left: side, right: side }]}>
    <View style={[s.search, { borderRadius: radius, height }]}>
      <Search size={18} color={maroon} aria-hidden />
      <TextInput accessibilityLabel="Search restaurants and meal kits" value={query} onChangeText={setQuery}
        placeholder="Search restaurants and meal kits" placeholderTextColor={muted} style={s.input} maxLength={120}
        autoCorrect={false} returnKeyType="search" clearButtonMode="never" />
      {!!query && <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setQuery('')} style={s.clear}>
        <X size={18} color={maroon} aria-hidden />
      </Pressable>}
    </View>
  </View>;
}

const s = StyleSheet.create({
  header: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1 },
  headerSurface: { position: 'absolute', left: 0, right: 0, overflow: 'hidden' },
  welcome: { width: '100%', maxWidth: homeContentMaxWidth, alignSelf: 'center', overflow: 'hidden' },
  greeting: { color: maroon, fontFamily: sans, fontWeight: '500', lineHeight: 42 },
  staticGreeting: { color: maroon, fontSize: 32, fontWeight: '500', lineHeight: 42, marginBottom: 16 },
  searchDock: { position: 'absolute', alignItems: 'center', zIndex: 1 },
  search: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 9, borderWidth: 1, borderColor: '#DCCAC1', backgroundColor: '#FFFFFF', paddingLeft: 13, paddingRight: 4, boxShadow: '0 4px 16px rgba(39,29,25,.10)' },
  input: { minWidth: 0, flex: 1, height: '100%', fontSize: 16, color: '#271D19', paddingRight: 8 },
  clear: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
