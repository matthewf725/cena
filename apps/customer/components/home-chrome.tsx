import type { ReactNode } from 'react';
import { Animated, Platform, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { Search, X } from 'lucide-react-native';
import { Text, TextInput } from './type';

export const welcomeHeight = 60;
export const welcomeFadeEnd = 140;
export const searchGap = 12;
export const homeContentMaxWidth = 760;

const maroon = '#46110E';
const muted = '#77645B';
const greetingFont = Platform.select({ ios: 'System', android: 'sans-serif', default: 'system-ui' });
const headerTail = 40;

function gradient(image: string) {
  return Platform.OS === 'web' ? { backgroundImage: image } as ViewStyle : { experimental_backgroundImage: image };
}

const creamSurface = gradient('linear-gradient(180deg, #FAF6F3 0%, #FAF6F3 64%, rgba(250, 246, 243, .96) 73%, rgba(250, 246, 243, .71) 84%, rgba(250, 246, 243, .29) 94%, rgba(250, 246, 243, 0) 100%)');
const warmSurface = gradient('linear-gradient(180deg, #FFDACE 0%, #F9E3DA 49%, #FAF6F3 73%, rgba(250, 246, 243, .74) 84%, rgba(250, 246, 243, .29) 94%, rgba(250, 246, 243, 0) 100%)');

export function PageHeader({ children, identityHeight, topInset }: {
  children: ReactNode;
  identityHeight: number;
  topInset: number;
}) {
  return <View pointerEvents="box-none" style={s.pageHeader}>
    <HeaderSurface height={identityHeight + topInset + headerTail + 14} topInset={topInset} />
    {children}
  </View>;
}

function HeaderSurface({ height, topInset, warmOpacity = 1 }: {
  height: number | Animated.AnimatedInterpolation<number>;
  topInset: number;
  warmOpacity?: number | Animated.AnimatedInterpolation<number>;
}) {
  return <Animated.View pointerEvents="none" style={[s.headerSurface, creamSurface, { top: -topInset, height }]}>
    <Animated.View style={[StyleSheet.absoluteFillObject, warmSurface, { opacity: warmOpacity }]} />
  </Animated.View>;
}

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
    inputRange: [0, 20, welcomeFadeEnd], outputRange: [start, start, end], extrapolate: 'clamp',
  });

  return <View pointerEvents="box-none" style={s.header}>
    <HeaderSurface topInset={topInset}
      height={reduced ? identityHeight + topInset + welcomeHeight + headerTail : collapse(identityHeight + topInset + welcomeHeight + headerTail, identityHeight + topInset + headerTail)}
      warmOpacity={reduced ? 1 : collapse(1, 0)} />
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
      <TextInput accessibilityLabel="Search restaurants" value={query} onChangeText={setQuery}
        placeholder="Search restaurants" placeholderTextColor={muted} style={s.input} maxLength={120}
        autoCorrect={false} returnKeyType="search" clearButtonMode="never" />
      {!!query && <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => setQuery('')} style={s.clear}>
        <X size={18} color={maroon} aria-hidden />
      </Pressable>}
    </View>
  </View>;
}

const s = StyleSheet.create({
  header: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1 },
  pageHeader: { zIndex: 1 },
  headerSurface: { position: 'absolute', left: 0, right: 0, overflow: 'hidden' },
  welcome: { width: '100%', maxWidth: homeContentMaxWidth, alignSelf: 'center', overflow: 'hidden' },
  greeting: { color: maroon, fontFamily: greetingFont, fontWeight: '400', lineHeight: 42, letterSpacing: -0.7 },
  staticGreeting: { color: maroon, fontFamily: greetingFont, fontSize: 32, fontWeight: '400', lineHeight: 42, letterSpacing: -0.7, marginBottom: 16 },
  searchDock: { position: 'absolute', alignItems: 'center', zIndex: 1 },
  search: { width: '100%', flexDirection: 'row', alignItems: 'center', gap: 9, borderWidth: 1, borderColor: '#DCCAC1', backgroundColor: '#FFFFFF', paddingLeft: 13, paddingRight: 4, boxShadow: '0 4px 16px rgba(39,29,25,.10)' },
  input: { minWidth: 0, flex: 1, height: '100%', fontSize: 16, color: '#271D19', paddingRight: 8 },
  clear: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
