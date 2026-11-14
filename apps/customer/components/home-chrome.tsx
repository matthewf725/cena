import type { ReactNode } from 'react';
import { Animated, Platform, Pressable, StyleSheet, Text, TextInput, View, type ViewStyle } from 'react-native';
import { Search, X } from 'lucide-react-native';

export const identityHeight = 58;
export const welcomeHeight = 60;
export const searchHeight = 48;
export const searchGap = 12;

const maroon = '#5D100A';
const muted = '#77645B';
const blur = Platform.OS === 'web' ? {
  backdropFilter: 'blur(14px)',
  WebkitBackdropFilter: 'blur(14px)',
} as ViewStyle : undefined;

export function HomeWelcome({ greeting }: { greeting: string }) {
  return <Text accessibilityRole="header" numberOfLines={1} style={s.staticGreeting}>{greeting}</Text>;
}

export function HomeHeader({ children, scrollY, reduced, greeting, collapsed, side }: {
  children: ReactNode;
  scrollY: Animated.Value;
  reduced: boolean;
  greeting: string;
  collapsed: boolean;
  side: number;
}) {
  const collapse = (start: number, end: number) => scrollY.interpolate({
    inputRange: [0, welcomeHeight], outputRange: [start, end], extrapolate: 'clamp',
  });

  return <View pointerEvents="box-none" style={s.header}>
    <Animated.View pointerEvents="none" style={[s.headerSurface, blur, {
      height: reduced ? identityHeight : collapse(identityHeight + welcomeHeight, identityHeight),
    }]}>
      <Animated.View style={[StyleSheet.absoluteFillObject, s.headerTint, { opacity: reduced ? 1 : collapse(1, 0) }]} />
    </Animated.View>
    {children}
    {!reduced && <Animated.View pointerEvents="none" aria-hidden={collapsed}
      accessibilityElementsHidden={collapsed} importantForAccessibility={collapsed ? 'no-hide-descendants' : 'auto'}
      style={[s.welcome, { height: collapse(welcomeHeight, 0), paddingHorizontal: side }]}>
      <Animated.Text accessibilityRole="header" numberOfLines={1} style={[s.greeting, {
        opacity: collapse(1, 0), fontSize: collapse(30, 19), transform: [{ translateY: collapse(0, -14) }],
      }]}>{greeting}</Animated.Text>
    </Animated.View>}
  </View>;
}

export function HomeSearch({ query, setQuery, bottom, radius, side }: {
  query: string;
  setQuery: (value: string) => void;
  bottom: number;
  radius: number;
  side: number;
}) {
  return <View pointerEvents="box-none" style={[s.searchDock, { bottom, left: side, right: side }]}>
    <View style={[s.search, { borderRadius: radius }]}>
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
  headerSurface: { position: 'absolute', top: 0, left: 0, right: 0, overflow: 'hidden', backgroundColor: 'rgba(250,246,243,.84)', borderBottomWidth: 1, borderBottomColor: '#E8DCD5' },
  headerTint: { backgroundColor: '#FFE1D5' },
  welcome: { overflow: 'hidden' },
  greeting: { color: maroon, fontWeight: '800', lineHeight: 42, letterSpacing: -0.8 },
  staticGreeting: { color: maroon, fontWeight: '800', fontSize: 30, lineHeight: 42, letterSpacing: -0.8, marginBottom: 16 },
  searchDock: { position: 'absolute', alignItems: 'flex-end', zIndex: 1 },
  search: { width: '100%', maxWidth: 340, height: searchHeight, flexDirection: 'row', alignItems: 'center', gap: 9, borderWidth: 1, borderColor: '#DCCAC1', backgroundColor: '#FFFFFF', paddingLeft: 13, paddingRight: 4, boxShadow: '0 4px 16px rgba(39,29,25,.10)' },
  input: { minWidth: 0, flex: 1, height: '100%', fontSize: 16, color: '#271D19', paddingRight: 8 },
  clear: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
