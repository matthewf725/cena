import { Stack } from 'expo-router';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { sans } from '../components/type';

const fonts = {
  [sans]: require('../assets/fonts/AtkinsonHyperlegibleNext-Variable.ttf'),
};

export default function Layout() {
  const [loaded, error] = useFonts(fonts);
  if (!loaded && !error) return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FAF6F3' }}>
    <ActivityIndicator color="#5D100A" accessibilityLabel="Loading Cena" />
  </View>;
  return <SafeAreaProvider><StatusBar style="dark" /><Stack screenOptions={{ headerShown: false }} /></SafeAreaProvider>;
}
