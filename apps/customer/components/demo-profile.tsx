import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { MapPin, Soup } from 'lucide-react-native';
import { Text } from './type';
import type { CalPolyDemo } from '../lib/cal-poly-demo';

export function DemoProfile({ profile, pickupArea, topSpace, bottomSpace, loading, retry, signIn }: {
  profile?: CalPolyDemo['profile'];
  pickupArea?: CalPolyDemo['pickup_area'];
  topSpace: number;
  bottomSpace: number;
  loading: boolean;
  retry: () => void;
  signIn: () => void;
}) {
  return <ScrollView showsVerticalScrollIndicator={false}
    contentContainerStyle={[styles.content, { paddingTop: topSpace + 20, paddingBottom: bottomSpace }]}>
    <Text accessibilityRole="header" style={styles.title}>Profile</Text>
    {profile ? <>
      <View style={styles.card}>
        <View style={styles.avatar}><Text style={styles.initial}>{Array.from(profile.display_name)[0]?.toLocaleUpperCase()}</Text></View>
        <View style={styles.identity}>
          <Text style={styles.name}>{profile.display_name}</Text>
          <Text style={styles.detail}>Cal Poly demo account</Text>
        </View>
      </View>
      {!!pickupArea?.label && <View style={styles.card}>
        <MapPin size={20} color={maroon} aria-hidden />
        <View style={styles.identity}><Text style={styles.label}>Saved pickup area</Text><Text style={styles.detail}>{pickupArea.label}</Text></View>
      </View>}
      {!!profile.equipment?.length && <View style={styles.card}>
        <Soup size={20} color={maroon} aria-hidden />
        <View style={styles.identity}><Text style={styles.label}>Kitchen equipment</Text><Text style={styles.detail}>{profile.equipment.join(' · ')}</Text></View>
      </View>}
    </> : loading ? <ActivityIndicator color={maroon} accessibilityLabel="Loading demo profile" /> : <>
      <Text style={styles.detail}>Couldn’t load the demo account.</Text>
      <Pressable accessibilityRole="button" style={styles.button} onPress={retry}><Text style={styles.buttonText}>Try again</Text></Pressable>
    </>}
    <Pressable accessibilityRole="button" style={styles.button} onPress={signIn}><Text style={styles.buttonText}>Sign in</Text></Pressable>
  </ScrollView>;
}

const maroon = '#5D100A';
const styles = StyleSheet.create({
  content: { paddingHorizontal: 22, gap: 12 },
  title: { color: '#271D19', fontSize: 30, fontWeight: '500', marginBottom: 4 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: '#E8DCD5', backgroundColor: '#FFFDFB' },
  avatar: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: '#F4E4DA' },
  initial: { color: maroon, fontSize: 19, fontWeight: '500' },
  identity: { flex: 1 },
  name: { color: '#271D19', fontSize: 17, fontWeight: '600' },
  label: { color: '#271D19', fontSize: 14, fontWeight: '600' },
  detail: { color: '#77645B', fontSize: 14, lineHeight: 18, marginTop: 3 },
  button: { minHeight: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: maroon },
  buttonText: { color: maroon, fontSize: 15, fontWeight: '600' },
});
