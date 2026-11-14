import React, { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ActivityIndicator, Linking, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Check, ChevronRight, Mail, Phone, Soup, UserRound } from 'lucide-react-native';
import { supabase } from '../lib/supabase';
import { loadCustomerAccount, saveCustomerAccount, sendCustomerSignInCode, signOutCustomer, verifyCustomerSignInCode } from '../lib/profile';

type Props = {
  equipment: string[]; setEquipment: (value: string[]) => void;
  analyticsConsented: boolean; setAnalyticsConsented: (value: boolean) => void;
  email: string; setEmail: (value: string) => void;
  phone: string; setPhone: (value: string) => void;
  displayName: string; setDisplayName: (value: string) => void;
};

const options = ['Oven', 'Stovetop', 'Toaster', 'Panini press'];
const localAnalyticsChoiceKey = 'cena.customer.analytics-consent-explicit.v1';
const profileSessionUserKey = 'cena.customer.profile-session-user.v1';

export function Account(props: Props) {
  const [signedIn, setSignedIn] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [hydrating, setHydrating] = useState(Boolean(supabase));
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [localConsentExplicit, setLocalConsentExplicit] = useState(false);
  const [expandedPolicy, setExpandedPolicy] = useState<'terms.html'|'privacy.html'|null>(null);

  useEffect(() => {
    let alive = true;
    if (!supabase) { setHydrating(false); return; }
    async function hydrate() {
      try {
        const localChoice = await AsyncStorage.getItem(localAnalyticsChoiceKey).catch(() => null);
        if (!alive) return;
        setLocalConsentExplicit(localChoice === 'true');
        const previousAccountUserId = await AsyncStorage.getItem(profileSessionUserKey).catch(() => null);
        const account = await loadCustomerAccount();
        if (!alive) return;
        if (account) {
          void AsyncStorage.setItem(profileSessionUserKey, account.userId).catch(() => {});
          props.setEmail(account.email);
          props.setDisplayName(account.profile.displayName);
          props.setPhone(account.profile.phone);
          props.setEquipment(account.profile.equipment);
          props.setAnalyticsConsented(account.analyticsConsented);
          setSignedIn(true);
        } else {
          setSignedIn(false);
          if (previousAccountUserId) {
            // Drop stale account-backed fields if the session was cleared elsewhere.
            props.setEmail(''); props.setDisplayName(''); props.setPhone(''); props.setEquipment([]);
            void AsyncStorage.removeItem(profileSessionUserKey).catch(() => {});
          }
          // Local analytics is off unless the user explicitly chose it in Account.
          if (localChoice !== 'true') props.setAnalyticsConsented(false);
        }
      } catch (e) { if (alive) setError(e instanceof Error ? e.message : 'Could not load your saved profile.'); }
      finally { if (alive) setHydrating(false); }
    }
    void hydrate();
    return () => { alive = false; };
  }, []);

  const reportError = (e: unknown) => setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
  async function requestCode() {
    setBusy(true); setError(''); setMessage('');
    try { await sendCustomerSignInCode(props.email); setCodeSent(true); setMessage('Check your email for a 6-digit sign-in code.'); }
    catch (e) { reportError(e); }
    finally { setBusy(false); }
  }
  async function verifyCode() {
    setBusy(true); setHydrating(true); setError(''); setMessage('');
    try {
      const user = await verifyCustomerSignInCode(props.email, code);
      void AsyncStorage.setItem(profileSessionUserKey, user.id).catch(() => {});
      setSignedIn(true); setCodeSent(false); setCode('');
      const account = await loadCustomerAccount();
      if (account) {
        props.setEmail(account.email); props.setDisplayName(account.profile.displayName); props.setPhone(account.profile.phone);
        props.setEquipment(account.profile.equipment); props.setAnalyticsConsented(account.analyticsConsented);
      }
      setMessage('Signed in. Your saved Cena profile is ready.');
    } catch (e) { reportError(e); }
    finally { setBusy(false); setHydrating(false); }
  }
  async function save() {
    if (!supabase || !signedIn) { setMessage('Saved on this device. Sign in to sync your profile across devices.'); return; }
    setBusy(true); setError(''); setMessage('');
    try { await saveCustomerAccount({ displayName: props.displayName, phone: props.phone, equipment: props.equipment }, props.analyticsConsented); setMessage('Your profile and privacy choice are saved.'); }
    catch (e) { reportError(e); }
    finally { setBusy(false); }
  }
  async function signOut() {
    setBusy(true); setError(''); setMessage('');
    try {
      await signOutCustomer();
      setSignedIn(false); setCodeSent(false); setCode(''); props.setEmail(''); props.setDisplayName(''); props.setPhone(''); props.setEquipment([]);
      void AsyncStorage.removeItem(profileSessionUserKey).catch(() => {});
      if (!localConsentExplicit) props.setAnalyticsConsented(false);
      setMessage('You are signed out. Account details were cleared from this device.');
    }
    catch (e) { reportError(e); }
    finally { setBusy(false); }
  }
  async function openPolicy(path: 'terms.html'|'privacy.html') {
    setExpandedPolicy(null);
    const base = process.env.EXPO_PUBLIC_CENA_SITE_URL;
    if (base) {
      try { await Linking.openURL(`${base.replace(/\/$/, '')}/${path}`); return; }
      catch { /* show the in-app policy summary below */ }
    }
    setExpandedPolicy(current => current === path ? null : path);
  }

  function changeAnalyticsConsent(value: boolean) {
    props.setAnalyticsConsented(value);
    setLocalConsentExplicit(true);
    void AsyncStorage.setItem(localAnalyticsChoiceKey, 'true').catch(() => {});
  }

  const locked = hydrating || busy;

  return <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={s.content}>
    <Text style={s.eyebrow}>YOUR CENA</Text><Text style={s.title}>A little about you.</Text>
    <View style={s.hero}><View style={s.avatar}><Text style={s.initial}>{props.displayName.trim().charAt(0).toUpperCase() || 'C'}</Text></View><View style={{flex:1}}><Text style={s.name}>{signedIn ? (props.displayName.trim() || 'Welcome back') : 'Welcome to Cena'}</Text><Text style={s.hint}>{signedIn ? props.email : 'Keep pickup details handy. Sign in to sync across devices.'}</Text></View><ChevronRight size={18} color={muted}/></View>
    {hydrating && <View style={s.loading}><ActivityIndicator color={maroon}/><Text style={s.hint}>Loading your saved profile…</Text></View>}
    <Text style={s.section}>YOUR DETAILS</Text>
    <Field icon={<UserRound size={17} color={maroon}/>} label="Name"><TextInput style={s.input} value={props.displayName} onChangeText={props.setDisplayName} autoCapitalize="words" maxLength={80} placeholder="Add your name" placeholderTextColor={muted} editable={!locked}/></Field>
    <Field icon={<Mail size={17} color={maroon}/>} label="Email"><TextInput style={s.input} value={props.email} onChangeText={value => { props.setEmail(value); setCodeSent(false); setCode(''); }} keyboardType="email-address" autoCapitalize="none" autoCorrect={false} placeholder="Add an email address" placeholderTextColor={muted} editable={!signedIn&&!locked}/></Field>
    <Field icon={<Phone size={17} color={maroon}/>} label="Mobile number"><TextInput style={s.input} value={props.phone} onChangeText={props.setPhone} keyboardType="phone-pad" placeholder="Add a phone number" placeholderTextColor={muted} editable={!locked}/></Field>
    {supabase && !signedIn && <View style={s.authBox}>
      {!codeSent ? <Pressable accessibilityRole="button" disabled={locked || !props.email.includes('@')} onPress={() => void requestCode()} style={[s.primary,locked&&s.disabled]}>{busy?<ActivityIndicator color="#FFF"/>:<Text style={s.primaryText}>Email me a sign-in code</Text>}</Pressable> : <><TextInput style={s.code} value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={8} placeholder="6-digit code" placeholderTextColor={muted} editable={!locked}/><Pressable accessibilityRole="button" disabled={locked || code.trim().length<6} onPress={() => void verifyCode()} style={[s.primary,locked&&s.disabled]}>{busy?<ActivityIndicator color="#FFF"/>:<Text style={s.primaryText}>Verify and load profile</Text>}</Pressable><Pressable disabled={locked} onPress={() => void requestCode()}><Text style={s.link}>Send a new code</Text></Pressable></>}
    </View>}
    <Text style={s.section}>MAKE PICKUP EASIER</Text><View style={s.equipment}><View style={s.rowTitle}><Soup size={17} color={green}/><Text style={s.label}>Kitchen equipment</Text></View><Text style={s.desc}>We’ll flag meal kits that need something you don’t have.</Text><View style={s.chips}>{options.map(x=><Pressable key={x} disabled={locked} accessibilityRole="checkbox" accessibilityState={{checked:props.equipment.includes(x)}} onPress={()=>props.setEquipment(props.equipment.includes(x)?props.equipment.filter(y=>y!==x):[...props.equipment,x])} style={[s.chip,props.equipment.includes(x)&&s.chipOn,locked&&s.disabled]}><Text style={[s.chipText,props.equipment.includes(x)&&{color:maroon}]}>{props.equipment.includes(x)?'✓  ':''}{x}</Text></Pressable>)}</View></View>
    <Text style={s.section}>PAYMENT & PREFERENCES</Text><View style={s.setting}><Text style={s.label}>Payment methods</Text><Text style={s.desc}>Payment happens when you pick up.</Text></View>
    <Text style={s.section}>PRIVACY</Text><Pressable disabled={locked} accessibilityRole="checkbox" accessibilityState={{checked:props.analyticsConsented}} onPress={()=>changeAnalyticsConsent(!props.analyticsConsented)} style={[s.consent,locked&&s.disabled]}><View style={[s.checkbox,props.analyticsConsented&&s.checkboxOn]}>{props.analyticsConsented&&<Check size={14} color="#FFF"/>}</View><View style={{flex:1}}><Text style={s.label}>Share anonymous usage data</Text><Text style={s.desc}>Optional browsing events; change this choice any time.</Text></View></Pressable>
    <Pressable accessibilityRole="button" disabled={locked} onPress={()=>void save()} style={[s.primary,s.save,locked&&s.disabled]}>{busy?<ActivityIndicator color="#FFF"/>:<Text style={s.primaryText}>{signedIn?'Save profile and privacy choice':'Save on this device'}</Text>}</Pressable>
    {signedIn&&<Pressable accessibilityRole="button" disabled={locked} onPress={()=>void signOut()} style={s.secondary}><Text style={s.secondaryText}>Sign out</Text></Pressable>}
    {!!message&&<Text accessibilityLiveRegion="polite" style={s.message}>{message}</Text>}{!!error&&<Text accessibilityLiveRegion="polite" style={s.error}>{error}</Text>}
    <View style={s.legal}><Pressable onPress={()=>void openPolicy('terms.html')}><Text style={s.link}>Consumer Terms</Text></Pressable><Text style={s.hint}> · </Text><Pressable onPress={()=>void openPolicy('privacy.html')}><Text style={s.link}>Privacy Policy</Text></Pressable></View>
    {!!expandedPolicy&&<View style={s.policy}><Text style={s.label}>{expandedPolicy === 'terms.html' ? 'Consumer terms' : 'Privacy policy'}</Text><Text style={s.desc}>{expandedPolicy === 'terms.html'
      ? 'Orders reserve restaurant-prepared items for pickup. Cena does not take payment in the app. Restaurants are responsible for menu and allergen details.'
      : 'Your email and optional phone link and manage pickup orders. Anonymous browsing analytics are optional and off until you choose to share them.'}</Text><Pressable onPress={()=>setExpandedPolicy(null)}><Text style={s.link}>Close</Text></Pressable></View>}
    <Text style={s.footer}>Made for good food and the people around your table.</Text>
  </ScrollView>;
}

function Field({icon,label,children}:{icon:React.ReactNode;label:string;children:React.ReactNode}) { return <View style={s.field}><View style={s.fieldIcon}>{icon}</View><View style={{flex:1}}><Text style={s.label}>{label}</Text>{children}</View></View>; }
const maroon='#5D100A', ink='#231F1C', muted='#605751', line='#EDE5E0', green='#245C40';
const s=StyleSheet.create({
  content:{paddingHorizontal:22,paddingTop:20,paddingBottom:120},eyebrow:{fontSize:9,fontWeight:'800',letterSpacing:1.1,color:muted},title:{fontSize:35,fontWeight:'700',color:ink,letterSpacing:-.8,marginTop:5,marginBottom:20},
  hero:{flexDirection:'row',alignItems:'center',gap:12,padding:14,backgroundColor:'#FFF',borderRadius:12,borderWidth:1,borderColor:line,marginBottom:17},avatar:{width:46,height:46,borderRadius:23,backgroundColor:'#EADAD2',alignItems:'center',justifyContent:'center'},initial:{fontSize:19,color:maroon,fontWeight:'700'},name:{fontSize:17,color:ink,fontWeight:'700'},hint:{fontSize:10,color:muted,marginTop:3},
  loading:{flexDirection:'row',alignItems:'center',gap:8,marginBottom:8},section:{fontSize:9,fontWeight:'800',letterSpacing:1.1,color:muted,marginTop:12,marginBottom:7},field:{minHeight:61,flexDirection:'row',alignItems:'center',gap:10,borderBottomWidth:1,borderBottomColor:line},fieldIcon:{width:34,height:34,borderRadius:9,backgroundColor:'#F2E9E5',alignItems:'center',justifyContent:'center'},label:{fontSize:12,fontWeight:'700',color:ink},input:{fontSize:11,color:ink,marginTop:3,paddingVertical:3},
  authBox:{marginTop:12,gap:8},primary:{minHeight:48,backgroundColor:maroon,borderRadius:10,alignItems:'center',justifyContent:'center',paddingHorizontal:14},primaryText:{fontSize:12,color:'#FFF',fontWeight:'700'},disabled:{opacity:.55},code:{height:46,borderRadius:9,borderWidth:1,borderColor:line,backgroundColor:'#FFF',paddingHorizontal:13,fontSize:14,color:ink},link:{fontSize:11,color:maroon,fontWeight:'700',paddingVertical:7},
  equipment:{paddingVertical:10},rowTitle:{flexDirection:'row',alignItems:'center',gap:7},desc:{fontSize:10,color:muted,marginTop:4,lineHeight:15},chips:{flexDirection:'row',flexWrap:'wrap',gap:6,marginTop:10},chip:{paddingHorizontal:9,paddingVertical:8,borderWidth:1,borderColor:line,borderRadius:20,backgroundColor:'#FFF'},chipOn:{borderColor:'#B77A6E',backgroundColor:'#F7EBE8'},chipText:{fontSize:9,color:ink},setting:{paddingVertical:12,borderBottomWidth:1,borderBottomColor:line},consent:{minHeight:72,flexDirection:'row',alignItems:'center',gap:10,borderBottomWidth:1,borderBottomColor:line},checkbox:{width:20,height:20,borderWidth:1,borderColor:'#C6BAB4',borderRadius:5,alignItems:'center',justifyContent:'center'},checkboxOn:{backgroundColor:maroon,borderColor:maroon},
  save:{marginTop:17},secondary:{height:43,borderWidth:1,borderColor:'#E2D1CB',borderRadius:9,alignItems:'center',justifyContent:'center',marginTop:8},secondaryText:{fontSize:11,color:maroon,fontWeight:'700'},message:{fontSize:11,color:green,textAlign:'center',marginTop:10},error:{fontSize:11,color:'#A23B30',textAlign:'center',marginTop:10},policy:{marginTop:12,padding:13,borderWidth:1,borderColor:line,borderRadius:9,backgroundColor:'#FFF'},legal:{flexDirection:'row',justifyContent:'center',alignItems:'center',marginTop:18},footer:{fontStyle:'italic',textAlign:'center',color:'#9A8981',fontSize:13,marginTop:22},
});
