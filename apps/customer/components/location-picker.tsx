import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { LocateFixed, X } from 'lucide-react-native';
import type { PickupOrigin } from '../lib/discovery';

type AddressLocation = PickupOrigin & { label: string };

export function LocationPicker({ close, useDevice, useAddress, reset, locating }: {
  close: () => void;
  useDevice: () => void;
  useAddress: (address: AddressLocation) => void;
  reset: () => void;
  locating: boolean;
}) {
  const [address, setAddress] = useState('');
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const busy = locating || searching;

  async function findAddress() {
    if (busy || address.trim().length < 8) return;
    const api = process.env.EXPO_PUBLIC_CENA_API_URL;
    if (!api) {
      setError('Address lookup is unavailable in this preview. You can still use your device location.');
      return;
    }
    setSearching(true);
    setError('');
    try {
      const response = await fetch(`${api.replace(/\/$/, '')}/v1/geocode?address=${encodeURIComponent(address.trim())}`);
      if (response.status === 404 || response.status === 422) {
        setError('Enter a California street address with a city or ZIP code.');
        return;
      }
      if (!response.ok) throw new Error('Address lookup failed');
      const result: AddressLocation = await response.json();
      if (!result.label || !Number.isFinite(result.latitude) || !Number.isFinite(result.longitude)) throw new Error('Invalid address result');
      useAddress(result);
    } catch {
      setError('Couldn’t look up that address. Try again or use your current location.');
    } finally {
      setSearching(false);
    }
  }

  return <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <Pressable style={styles.scrim} onPress={close} disabled={busy} accessibilityElementsHidden importantForAccessibility="no" />
    <View style={styles.card} accessibilityViewIsModal>
      <View style={styles.heading}>
        <Text accessibilityRole="header" style={styles.title}>Pickup area</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Close pickup area" onPress={close} disabled={busy} style={styles.close}>
          <X size={21} color={maroon} />
        </Pressable>
      </View>
      <Text style={styles.helper}>Enter an address to see kitchens and pickup distances near it.</Text>
      <TextInput accessibilityLabel="Street address, city or ZIP code" style={styles.input} value={address}
        onChangeText={value => { setAddress(value); setError(''); }} editable={!busy} maxLength={200}
        placeholder="Street address, city or ZIP code" placeholderTextColor="#605751" returnKeyType="search"
        onSubmitEditing={() => void findAddress()} />
      {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      <Pressable accessibilityRole="button" onPress={() => void findAddress()} disabled={busy || address.trim().length < 8}
        style={[styles.button, (busy || address.trim().length < 8) && styles.disabled]}>
        {searching && <ActivityIndicator color="#FFF" />}<Text style={styles.buttonText}>Use this address</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={useDevice} disabled={busy} style={styles.link}>
        {locating ? <ActivityIndicator color={maroon} /> : <LocateFixed size={17} color={maroon} />}
        <Text style={styles.linkText}>Use my current location</Text>
      </Pressable>
      <Pressable accessibilityRole="button" onPress={reset} disabled={busy} style={styles.link}>
        <Text style={styles.linkText}>Use San Francisco</Text>
      </Pressable>
    </View>
  </KeyboardAvoidingView>;
}

const maroon = '#5D100A';
const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, zIndex: 25, justifyContent: 'center', padding: 14 },
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(28,18,14,.45)' },
  card: { padding: 16, backgroundColor: '#FAF6F3', borderRadius: 22, gap: 10, width: '100%', maxWidth: 420, alignSelf: 'center' },
  heading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: '#231F1C', fontSize: 24, fontWeight: '800' },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  helper: { color: '#605751', fontSize: 14, lineHeight: 19 },
  input: { minHeight: 46, backgroundColor: '#FFF', borderWidth: 1, borderColor: '#D8CBC3', borderRadius: 13, paddingHorizontal: 12, color: '#231F1C', fontSize: 16 },
  button: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 13, backgroundColor: maroon },
  buttonText: { color: '#FFF', fontWeight: '800' }, disabled: { opacity: 0.55 },
  error: { color: maroon, fontSize: 14 },
  link: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 9, justifyContent: 'center' },
  linkText: { color: maroon, fontSize: 14, fontWeight: '700' },
});
