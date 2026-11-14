import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, View, type TextInput as TextInputHandle } from 'react-native';
import { MapPin, LocateFixed, Minus, Plus, X } from 'lucide-react-native';
import { Text, TextInput } from './type';
import { PageHeader } from './home-chrome';
import type { PickupOrigin } from '../lib/discovery';

type AddressLocation = PickupOrigin & { label: string };
type SelectionKind = 'address' | 'recent' | 'suggestion';

const publicAreas: AddressLocation[] = [
  { label: 'San Francisco City Hall', latitude: 37.7793, longitude: -122.4193 },
  { label: 'Oakland City Hall', latitude: 37.8044, longitude: -122.2712 },
  { label: 'Downtown Berkeley', latitude: 37.8716, longitude: -122.2727 },
];

function openMapPreview(location: PickupOrigin, zoom: number) {
  // Send only a generalized map tile (coordinates rounded to about 1 km) to OSM.
  const latitude = Math.max(-85, Math.min(85, Math.round(location.latitude * 100) / 100));
  const longitude = Math.max(-180, Math.min(180, Math.round(location.longitude * 100) / 100));
  const scale = 2 ** zoom;
  const worldX = ((longitude + 180) / 360) * scale;
  const x = Math.max(0, Math.min(scale - 1, Math.floor(worldX)));
  const radians = latitude * Math.PI / 180;
  const worldY = (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * scale;
  const y = Math.max(0, Math.min(scale - 1, Math.floor(worldY)));
  return {
    uri: `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`,
    markerX: worldX - x,
    markerY: worldY - y,
  };
}

export function LocationPicker({ close, useDevice, useAddress, reset, locating, origin, currentLabel, recentAddresses, deviceError }: {
  close: () => void;
  useDevice: () => void;
  useAddress: (address: AddressLocation) => void;
  reset: () => void;
  locating: boolean;
  origin: PickupOrigin;
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
  const currentLocation = useMemo<AddressLocation>(() => ({ label: currentLabel, ...origin }), [currentLabel, origin.latitude, origin.longitude]);
  const [address, setAddress] = useState('');
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<AddressLocation>(currentLocation);
  const [selected, setSelected] = useState<AddressLocation|null>(null);
  const [selectionKind, setSelectionKind] = useState<SelectionKind|null>(null);
  const [zoom, setZoom] = useState(11);
  const [mapFailed, setMapFailed] = useState(false);
  const busy = locating || searching;
  const mapPreview = useMemo(() => openMapPreview(preview, zoom), [preview.latitude, preview.longitude, zoom]);
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
    addressInput.current?.focus();
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
    setPreview(location);
    setSelected(location);
    setSelectionKind(kind);
    setAddress(kind === 'address' ? location.label : '');
    setError('');
    setMapFailed(false);
  }

  function applyLocation() {
    if (!selected || dismissed.current) return;
    dismissed.current=true;
    addressRef.current(selected);
  }

  async function findAddress() {
    if (busy || dismissed.current || address.trim().length < 8) return;
    const api = process.env.EXPO_PUBLIC_CENA_API_URL;
    if (!api) {
      setError('Address lookup is unavailable in this preview. You can still use your device location.');
      return;
    }
    setSearching(true);
    setError('');
    setSelected(null);
    const controller=new AbortController();
    lookupAbort.current=controller;
    try {
      const response = await fetch(`${api.replace(/\/$/, '')}/v1/geocode?address=${encodeURIComponent(address.trim())}`,{signal:controller.signal});
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
      setPreview(result);
      setSelected(result);
      setSelectionKind('address');
      setMapFailed(false);
    } catch {
      if(!dismissed.current&&mounted.current)setError('Couldn’t look up that address. Try again or use your current location.');
    } finally {
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
          <TextInput ref={addressInput} accessibilityLabel="Street address, city or ZIP code" style={styles.input} value={address}
            onChangeText={value => { setAddress(value); setError(''); setSelected(null); setSelectionKind(null); }} editable={!busy} maxLength={200}
            placeholder="Street address, city or ZIP code" placeholderTextColor="#77645B" returnKeyType="search"
            onSubmitEditing={() => void findAddress()} />
          <Text style={styles.privacy}>Address lookup sends the entered address to the U.S. Census geocoder. OpenStreetMap receives only a coarse map tile for this preview.</Text>
          {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
          {!!deviceError && <Text accessibilityRole="alert" style={styles.error}>{deviceError}</Text>}

          <View style={styles.mapCard}>
            <View style={styles.map}>
              <View pointerEvents="none" style={styles.mapFallback}>
                <View style={styles.park}/><View style={styles.roadOne}/><View style={styles.roadTwo}/><View style={styles.roadThree}/>
                <View style={styles.blockOne}/><View style={styles.blockTwo}/><View style={styles.blockThree}/>
              </View>
              {!mapFailed&&<Image accessibilityLabel="OpenStreetMap area preview" source={{uri:mapPreview.uri,...(Platform.OS==='web'?{}:{headers:{'User-Agent':'Cena pickup area map preview'}})}}
                resizeMode="cover" onError={()=>setMapFailed(true)} style={styles.mapImage}/>}
              <View pointerEvents="none" style={[styles.centerPin,{left:`${mapPreview.markerX*100}%`,top:`${mapPreview.markerY*100}%`}]}><MapPin size={25} color={maroon} fill="#FAF6F3" strokeWidth={2.5}/></View>
              <View style={styles.mapLabel}><Text style={styles.mapLabelText}>Approximate area · {preview.label}</Text></View>
              <View style={styles.zoomControls}>
                <Pressable accessibilityRole="button" accessibilityLabel="Zoom in on map" disabled={zoom>=12} onPress={()=>{setZoom(value=>Math.min(12,value+1));setMapFailed(false);}} style={[styles.zoomButton,zoom>=12&&styles.disabled]}><Plus size={17} color={maroon}/></Pressable>
                <Pressable accessibilityRole="button" accessibilityLabel="Zoom out on map" disabled={zoom<=10} onPress={()=>{setZoom(value=>Math.max(10,value-1));setMapFailed(false);}} style={[styles.zoomButton,zoom<=10&&styles.disabled]}><Minus size={17} color={maroon}/></Pressable>
              </View>
              <Pressable accessibilityRole="link" accessibilityLabel="OpenStreetMap attribution" onPress={()=>void Linking.openURL('https://www.openstreetmap.org/copyright').catch(()=>{})} style={styles.attribution}>
                <Text style={styles.attributionText}>© OpenStreetMap contributors</Text>
              </Pressable>
            </View>
            <Text style={styles.previewLabel}>Map preview for {preview.label}</Text>
          </View>

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
            <Text style={styles.resetText}>Use San Francisco</Text>
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
  overlay: { ...StyleSheet.absoluteFillObject, zIndex: 25, backgroundColor:'#FAF6F3' },
  screen: { flex:1, backgroundColor:'#FAF6F3' },
  scrollContent: { flexGrow:1, paddingBottom:24 },
  heading: { minHeight:64, flexDirection:'row', justifyContent:'space-between', alignItems:'center', paddingHorizontal:20 },
  title: { fontWeight:'500', color:'#271D19', fontSize:24 },
  close: { width:44, height:44, alignItems:'center', justifyContent:'center' },
  body: { paddingHorizontal:20, paddingTop:26, gap:12 },
  mapCard: { overflow:'hidden', borderRadius:18, borderWidth:1, borderColor:'#E8DCD5', backgroundColor:'#EAE9DC' },
  map: { width:'100%', maxWidth:340, aspectRatio:1, alignSelf:'center', overflow:'hidden', backgroundColor:'#EAE9DC' },
  mapFallback: { ...StyleSheet.absoluteFillObject, backgroundColor:'#E8E7D8', overflow:'hidden' },
  park: { position:'absolute', left:'8%',top:'12%',width:'30%',height:'30%',borderRadius:22,backgroundColor:'#C8D8BE' },
  roadOne: { position:'absolute',left:'-8%',top:'49%',width:'120%',height:20,backgroundColor:'#FAF6F3',transform:[{rotate:'-9deg'}] },
  roadTwo: { position:'absolute',left:'48%',top:'-20%',width:18,height:'140%',backgroundColor:'#FAF6F3',transform:[{rotate:'12deg'}] },
  roadThree: { position:'absolute',left:'12%',top:'8%',width:'100%',height:8,backgroundColor:'#D2C9B9',transform:[{rotate:'31deg'}] },
  blockOne: { position:'absolute',left:'10%',bottom:'10%',width:'22%',height:'17%',backgroundColor:'#DDD6C9',borderRadius:5 },
  blockTwo: { position:'absolute',right:'9%',top:'14%',width:'20%',height:'21%',backgroundColor:'#DDD6C9',borderRadius:5 },
  blockThree: { position:'absolute',right:'13%',bottom:'8%',width:'24%',height:'18%',backgroundColor:'#DDD6C9',borderRadius:5 },
  mapImage: { ...StyleSheet.absoluteFillObject, width:'100%',height:'100%' },
  centerPin: { position:'absolute',marginLeft:-13,marginTop:-23,alignItems:'center',justifyContent:'center' },
  mapLabel: { position:'absolute',left:10,top:10,maxWidth:'72%',backgroundColor:'rgba(250,246,243,.94)',borderRadius:10,paddingHorizontal:10,paddingVertical:7 },
  mapLabelText: { color:'#271D19',fontSize:11,fontWeight:'500' },
  zoomControls: { position:'absolute',right:10,top:10,gap:6 },
  zoomButton: { width:38,height:38,alignItems:'center',justifyContent:'center',backgroundColor:'#FAF6F3',borderRadius:10,borderWidth:1,borderColor:'#E8DCD5' },
  disabled: { opacity:.45 },
  attribution: { position:'absolute',left:6,bottom:5,paddingHorizontal:5,paddingVertical:3,backgroundColor:'rgba(250,246,243,.88)',borderRadius:4 },
  attributionText: { color:'#51453E',fontSize:9 },
  previewLabel: { color:'#77645B',fontSize:12,paddingHorizontal:11,paddingVertical:8 },
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
