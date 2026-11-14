import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View, type TextInput as TextInputHandle } from 'react-native';
import { MapPin, LocateFixed, X } from 'lucide-react-native';
import { Text, TextInput } from './type';
import { PageHeader } from './home-chrome';

type AddressLocation = { latitude: number; longitude: number; label: string };
type SelectionKind = 'address' | 'recent' | 'suggestion';

const publicAreas: AddressLocation[] = [
  { label: 'San Francisco City Hall', latitude: 37.7793, longitude: -122.4193 },
  { label: 'Oakland City Hall', latitude: 37.8044, longitude: -122.2712 },
  { label: 'Downtown Berkeley', latitude: 37.8716, longitude: -122.2727 },
];

export function LocationPicker({ close, useDevice, useAddress, reset, resetLabel = 'Use San Francisco', locating, currentLabel, recentAddresses, deviceError }: {
  close: () => void;
  useDevice: () => void;
  useAddress: (address: AddressLocation) => void;
  reset: () => void;
  resetLabel?: string;
  locating: boolean;
  currentLabel: string;
  recentAddresses: AddressLocation[];
  deviceError?: string;
}) {
  const addressInput = useRef<TextInputHandle>(null);
  const cardRef = useRef<View>(null);
  const closeRef = useRef(close);closeRef.current=close;
  const addressRef = useRef(useAddress);addressRef.current=useAddress;
  const dismissRef = useRef<()=>void>(()=>{});
  const dismissed = useRef(false);
  const mounted = useRef(false);
  const lookupAbort = useRef<AbortController|null>(null);
  const [address, setAddress] = useState('');
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<AddressLocation|null>(null);
  const [selectionKind, setSelectionKind] = useState<SelectionKind|null>(null);
  const busy = locating || searching;
  const recentSuggestions = useMemo(() => {
    const seen = new Set<string>();
    return recentAddresses.filter(item => {
      const key = item.label.trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 4);
  }, [recentAddresses]);

  dismissRef.current=()=>{
    if(dismissed.current)return;
    dismissed.current=true;
    lookupAbort.current?.abort();
    closeRef.current();
  };

  useEffect(() => {
    mounted.current=true;
    if (Platform.OS !== 'web') return ()=>{mounted.current=false;lookupAbort.current?.abort();};
    if (typeof window !== 'undefined' && !window.matchMedia('(pointer: coarse)').matches) addressInput.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        dismissRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const card = cardRef.current as unknown as HTMLElement | null;
      const focusable = card?.querySelectorAll<HTMLElement>('input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])');
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !card?.contains(current))) {
        event.preventDefault();last.focus();
      } else if (!event.shiftKey && (current === last || !card?.contains(current))) {
        event.preventDefault();first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {mounted.current=false;document.removeEventListener('keydown', onKeyDown);lookupAbort.current?.abort();};
  }, []);

  function chooseLocation(location: AddressLocation, kind: SelectionKind) {
    if (busy || dismissed.current) return;
    setSelected(location);
    setSelectionKind(kind);
    setAddress(kind === 'address' ? location.label : '');
    setError('');
  }

  function applyLocation() {
    if (!selected || dismissed.current) return;
    dismissed.current=true;
    addressRef.current(selected);
  }

  async function findAddress() {
    if (busy || dismissed.current || address.trim().length < 8) return;
    const api = process.env.EXPO_PUBLIC_CENA_API_URL || process.env.EXPO_PUBLIC_CENA_GEOCODE_URL;
    const useWorker = !process.env.EXPO_PUBLIC_CENA_API_URL && !!process.env.EXPO_PUBLIC_CENA_GEOCODE_URL;
    if (!api) {
      setError('Address lookup is unavailable in this preview. You can still use your device location.');
      return;
    }
    setSearching(true);
    setError('');
    setSelected(null);
    const controller=new AbortController();
    lookupAbort.current=controller;
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const endpoint = `${api.replace(/\/$/, '')}/v1/geocode`;
      const response = await fetch(useWorker ? endpoint : `${endpoint}?address=${encodeURIComponent(address.trim())}`, useWorker
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: address.trim() }), signal: controller.signal }
        : { signal: controller.signal });
      if(dismissed.current)return;
      if (response.status === 404 || response.status === 422) {
        setError('Enter a California street address with a city or ZIP code.');
        return;
      }
      if (!response.ok) throw new Error('Address lookup failed');
      const result: AddressLocation = await response.json();
      if(dismissed.current)return;
      if (!result.label || !Number.isFinite(result.latitude) || !Number.isFinite(result.longitude)) throw new Error('Invalid address result');
      setAddress(result.label);
      setSelected(result);
      setSelectionKind('address');
    } catch {
      if(!dismissed.current&&mounted.current)setError('Couldn’t look up that address. Try again or use your current location.');
    } finally {
      clearTimeout(timeout);
      if(lookupAbort.current===controller)lookupAbort.current=null;
      if(!dismissed.current&&mounted.current)setSearching(false);
    }
  }

  return <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View ref={cardRef} style={styles.screen}
      {...(Platform.OS==='web'?({role:'dialog','aria-modal':true} as any):{accessibilityViewIsModal:true})}>
      <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        <PageHeader identityHeight={58} topInset={0}>
          <View style={styles.heading}>
            <Text accessibilityRole="header" style={styles.title}>Pickup area</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Close pickup area" onPress={()=>dismissRef.current()} style={styles.close}>
              <X size={21} color={maroon} />
            </Pressable>
          </View>
        </PageHeader>
        <View style={styles.body}>
          <Text style={styles.helper}>Choose an area or enter an address to find nearby pickup kitchens.</Text>
          <View accessible accessibilityLabel={`Current pickup area, ${currentLabel}`} style={styles.currentArea}>
            <View style={styles.currentAreaIcon}><MapPin size={18} color={maroon}/></View>
            <View style={{flex:1}}><Text style={styles.currentAreaLabel}>Current pickup area</Text><Text style={styles.currentAreaName}>{currentLabel}</Text></View>
          </View>
          <TextInput ref={addressInput} accessibilityLabel="Street address, city or ZIP code" style={styles.input} value={address}
            onChangeText={value => { setAddress(value); setError(''); setSelected(null); setSelectionKind(null); }} editable={!busy} maxLength={200}
            placeholder="Street address, city or ZIP code" placeholderTextColor="#77645B" returnKeyType="search"
            onSubmitEditing={() => void findAddress()} />
          <Text style={styles.privacy}>Address lookup sends the entered address to the U.S. Census geocoder. It isn’t shared with restaurants.</Text>
          {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
          {!!deviceError && <Text accessibilityRole="alert" style={styles.error}>{deviceError}</Text>}

          <Pressable accessibilityRole="button" onPress={selected?applyLocation:()=>void findAddress()} disabled={busy || (!selected && address.trim().length < 8)}
            style={[styles.primary, (busy || (!selected && address.trim().length < 8)) && styles.disabled]}>
            {searching && <ActivityIndicator color="#FFF" />}
            <Text style={styles.primaryText}>{selected?(selectionKind==='address'?'Confirm this address':'Use this pickup area'):'Use this address'}</Text>
          </Pressable>
          {selected&&selectionKind==='address'&&<Text accessibilityLiveRegion="polite" style={styles.matchHint}>Matched address: {selected.label}</Text>}

          <Pressable accessibilityRole="button" onPress={useDevice} disabled={busy} style={styles.deviceButton}>
            {locating ? <ActivityIndicator color={maroon} /> : <LocateFixed size={18} color={maroon} />}
            <Text style={styles.deviceText}>Use my current location</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={reset} disabled={busy} style={styles.resetButton}>
            <Text style={styles.resetText}>{resetLabel}</Text>
          </Pressable>

          {!!recentSuggestions.length&&<View style={styles.suggestions}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>Recent places</Text>
            {recentSuggestions.map(item=><Suggestion key={`${item.label}-${item.latitude}-${item.longitude}`} item={item} onPress={()=>chooseLocation(item,'recent')} disabled={busy}/>)
            }
          </View>}
          <View style={styles.suggestions}>
            <Text accessibilityRole="header" style={styles.sectionTitle}>Suggested areas</Text>
            <Text style={styles.suggestionHelp}>Public city landmarks for a quick nearby preview.</Text>
            {publicAreas.map(item=><Suggestion key={item.label} item={item} onPress={()=>chooseLocation(item,'suggestion')} disabled={busy}/>)
            }
          </View>
        </View>
      </ScrollView>
    </View>
  </KeyboardAvoidingView>;
}

function Suggestion({item,onPress,disabled}:{item:AddressLocation;onPress:()=>void;disabled:boolean}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={`Preview ${item.label}`} onPress={onPress} disabled={disabled} style={styles.suggestion}>
    <View style={styles.suggestionIcon}><MapPin size={16} color={maroon}/></View>
    <Text style={styles.suggestionName}>{item.label}</Text>
    <Text style={styles.suggestionAction}>Preview</Text>
  </Pressable>;
}

const maroon = '#5D100A';
const green = '#245C40';
const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor:'#FAF6F3' },
  screen: { flex:1, backgroundColor:'#FAF6F3' },
  scrollContent: { flexGrow:1, paddingBottom:24 },
  heading: { minHeight:64, flexDirection:'row', justifyContent:'space-between', alignItems:'center', paddingHorizontal:20 },
  title: { fontWeight:'500', color:'#271D19', fontSize:24 },
  close: { width:44, height:44, borderRadius:22, borderWidth:1, borderColor:'#E8DCD5', backgroundColor:'#FFFDFA', alignItems:'center', justifyContent:'center' },
  body: { paddingHorizontal:20, paddingTop:18, gap:12 },
  helper: { color:'#77645B',fontSize:15,lineHeight:21 },
  currentArea: { minHeight:60,flexDirection:'row',alignItems:'center',gap:11,paddingHorizontal:12,backgroundColor:'#FFFDFA',borderRadius:13,borderWidth:1,borderColor:'#E8DCD5' },
  currentAreaIcon: { width:34,height:34,alignItems:'center',justifyContent:'center',borderRadius:17,backgroundColor:'#F5E9E1' },
  currentAreaLabel: { color:'#77645B',fontSize:11 },
  currentAreaName: { color:'#271D19',fontSize:14,fontWeight:'500',marginTop:2 },
  disabled: { opacity:.45 },
  input: { minHeight:50, backgroundColor:'#FFFDFA', borderWidth:1, borderColor:'#D8CBC3', borderRadius:13, paddingHorizontal:14, color:'#271D19', fontSize:16 },
  privacy: { color:'#77645B',fontSize:11,lineHeight:15,marginTop:-5 },
  error: { color:maroon,fontSize:13,lineHeight:18 },
  primary: { minHeight:50, flexDirection:'row', alignItems:'center', justifyContent:'center', gap:8, borderRadius:13, backgroundColor:maroon },
  primaryText: { color:'#FFF',fontWeight:'500',fontSize:15 },
  matchHint: { color:green,fontSize:12,marginTop:-6 },
  deviceButton: { minHeight:48,flexDirection:'row',alignItems:'center',justifyContent:'center',gap:9,borderRadius:13,borderWidth:1,borderColor:'#D8CBC3',backgroundColor:'#FFFDFA' },
  deviceText: { color:maroon,fontSize:14,fontWeight:'500' },
  resetButton: { minHeight:42,alignItems:'center',justifyContent:'center' },
  resetText: { color:maroon,fontSize:14,fontWeight:'500' },
  suggestions: { gap:7,marginTop:7 },
  sectionTitle: { color:'#271D19',fontSize:17,fontWeight:'500',marginBottom:1 },
  suggestionHelp: { color:'#77645B',fontSize:12,lineHeight:17,marginTop:-3 },
  suggestion: { minHeight:48,flexDirection:'row',alignItems:'center',gap:10,paddingHorizontal:10,backgroundColor:'#FFFDFA',borderRadius:12,borderWidth:1,borderColor:'#E8DCD5' },
  suggestionIcon: { width:30,height:30,borderRadius:15,alignItems:'center',justifyContent:'center',backgroundColor:'#F5E9E1' },
  suggestionName: { color:'#271D19',fontSize:14,fontWeight:'500',flex:1 },
  suggestionAction: { color:maroon,fontSize:12,fontWeight:'500' },
});
