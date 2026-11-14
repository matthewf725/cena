import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text as LogoText, View, useWindowDimensions } from 'react-native';
import { ArrowLeft, Check, Eye, EyeOff } from 'lucide-react-native';
import { StatusBar } from 'expo-status-bar';
import { createCustomerAccount, signInCustomerWithPassword, verifyCustomerSignup } from '../lib/profile';
import { useReducedMotion } from './motion';
import { Text, TextInput } from './type';

const maroon = '#5D100A';
const ivory = '#FAF6F3';
const muted = '#77645B';
const legalSite = (process.env.EXPO_PUBLIC_CENA_SITE_URL || 'https://cena-xi.vercel.app').replace(/\/$/, '');
type Screen = 'welcome' | 'sign-in' | 'sign-up' | 'verify';

export function AuthScreen({ topInset, bottomInset }: { topInset: number; bottomInset: number }) {
  const { width, height } = useWindowDimensions();
  const [screen, setScreen] = useState<Screen>('welcome');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const reduceMotion = useReducedMotion();
  const reveal = useRef(new Animated.Value(1)).current;
  const signingUp = screen === 'sign-up';
  const verifying = screen === 'verify';
  const title = verifying ? 'Verify email' : signingUp ? 'Sign up' : 'Sign in';
  const submitLabel = verifying ? 'Verify code' : title;
  const validEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const ready = verifying ? /^\d{6}$/.test(code) : validEmail && (signingUp ? password.length >= 6 && termsAccepted : !!password);
  const landscape = width >= 620 && height < 570;
  const artworkWidth = Math.min(560, width);
  const artworkHeight = Math.max(100, Math.min(310, (height - topInset - bottomInset) * .42));
  const wordmarkSize = Math.max(64, Math.min(136, width * .29, height * .22));

  useEffect(() => {
    if (screen !== 'welcome' || reduceMotion) {
      reveal.setValue(1);
      return;
    }
    reveal.setValue(0);
    const animation = Animated.timing(reveal, {
      toValue: 1,
      duration: 620,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    });
    animation.start();
    return () => animation.stop();
  }, [reduceMotion, reveal, screen]);

  function show(next: Screen) {
    setScreen(next);
    setPassword('');
    setPasswordVisible(false);
    setError('');
    setCode('');
  }

  async function submit() {
    if (busy || !ready) return;
    setBusy(true);
    setError('');
    try {
      if (verifying) await verifyCustomerSignup(email, code);
      else if (signingUp) {
        const account = await createCustomerAccount(email, password);
        if (account.needsVerification) show('verify');
      } else await signInCustomerWithPassword(email, password);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Couldn’t continue. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function openPolicy(file: string) {
    try { await Linking.openURL(`${legalSite}/${file}`); }
    catch { setError('Couldn’t open this page. Try again.'); }
  }

  if (screen === 'welcome') {
    return <View style={[s.welcome, { paddingTop: topInset, paddingBottom: Math.max(bottomInset, 24) }]}>
      <StatusBar style="light" />
      <View style={s.logoSpace}>
        <Animated.View pointerEvents="none" aria-hidden style={[s.artwork, {
          width: artworkWidth, height: artworkHeight, top: landscape ? '8%' : '18%',
          opacity: reveal,
          transform: [{translateY: reveal.interpolate({inputRange:[0,1], outputRange:[14,0]})}],
        }]}>
          <View style={[s.shape, s.arch, {width: artworkWidth * .44, height: artworkWidth * .49, borderRadius: artworkWidth * .22}]}/>
          <View style={[s.shape, s.peach, {width: artworkWidth * .31, height: artworkWidth * .31, borderRadius: artworkWidth * .155}]}/>
          <View style={[s.shape, s.accent, {width: artworkWidth * .07, height: artworkWidth * .07, borderRadius: artworkWidth * .035}]}/>
        </Animated.View>
        <LogoText style={[s.wordmark, { fontSize: wordmarkSize, lineHeight: wordmarkSize * 1.02, letterSpacing: -wordmarkSize * .075 }]} accessibilityRole="header" accessibilityLabel="Cena">
          cena<LogoText style={s.logoDot}>.</LogoText>
        </LogoText>
      </View>
      <View style={s.actions}>
        <Pressable accessibilityRole="button" style={[s.button, s.welcomePrimary]} onPress={() => show('sign-in')}>
          <Text style={s.welcomePrimaryText}>Sign in</Text>
        </Pressable>
        <Pressable accessibilityRole="button" style={[s.button, s.welcomeSecondary]} onPress={() => show('sign-up')}>
          <Text style={s.buttonText}>Sign up</Text>
        </Pressable>
      </View>
    </View>;
  }

  return <KeyboardAvoidingView style={s.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}
      contentContainerStyle={[s.body, { paddingTop: topInset + 22, paddingBottom: Math.max(bottomInset, 24) }]}>
      <View style={s.form}>
        <Pressable accessibilityRole="button" accessibilityLabel="Go back" disabled={busy}
          onPress={() => show(verifying ? 'sign-up' : 'welcome')} style={s.back}>
          <ArrowLeft size={23} color={maroon} />
        </Pressable>
        <Text accessibilityRole="header" style={s.title}>{title}</Text>
        {verifying ? <>
          <Text style={s.copy}>Enter the code sent to {email.trim()}.</Text>
          <TextInput accessibilityLabel="Verification code" placeholder="Verification code" placeholderTextColor={muted}
            style={s.input} editable={!busy} value={code} keyboardType="number-pad" textContentType="oneTimeCode"
            maxLength={6} onChangeText={value => setCode(value.replace(/\D/g, ''))} />
        </> : <>
          <TextInput accessibilityLabel="Email" placeholder="Email" placeholderTextColor={muted}
            style={s.input} value={email} editable={!busy} autoCapitalize="none" autoCorrect={false}
            autoComplete="email" keyboardType="email-address" onChangeText={setEmail} />
          <View style={s.passwordRow}>
            <TextInput accessibilityLabel="Password" placeholder="Password" placeholderTextColor={muted}
              style={s.passwordInput} editable={!busy} value={password} autoCapitalize="none" autoCorrect={false}
              autoComplete={signingUp ? 'new-password' : 'current-password'} textContentType={signingUp ? 'newPassword' : 'password'}
              secureTextEntry={!passwordVisible} onChangeText={setPassword} returnKeyType="go" onSubmitEditing={() => void submit()} />
            <Pressable accessibilityRole="button" accessibilityLabel={passwordVisible ? 'Hide password' : 'Show password'}
              onPress={() => setPasswordVisible(value => !value)} style={s.passwordToggle}>
              {passwordVisible ? <EyeOff size={20} color={maroon} /> : <Eye size={20} color={maroon} />}
            </Pressable>
          </View>
        </>}
        {signingUp && <>
          <Text style={s.copy}>Use at least 6 characters.</Text>
          <View style={s.termsRow}>
            <Pressable accessibilityRole="checkbox" accessibilityLabel="Agree to the Consumer Terms and Privacy Policy"
              accessibilityState={{ checked: termsAccepted }} disabled={busy}
              onPress={() => setTermsAccepted(current => !current)} style={s.checkboxTarget}>
              <View style={[s.checkbox, termsAccepted && s.checkboxOn]}>{termsAccepted && <Check size={14} color="#FFF" />}</View>
            </Pressable>
            <View style={s.termsText}>
              <Text style={s.termsCopy}>I agree to the</Text>
              <Pressable accessibilityRole="link" onPress={() => void openPolicy('terms.html')}><Text style={s.termsLink}>Consumer Terms</Text></Pressable>
              <Text style={s.termsCopy}>and</Text>
              <Pressable accessibilityRole="link" onPress={() => void openPolicy('privacy.html')}><Text style={s.termsLink}>Privacy Policy</Text></Pressable>
            </View>
          </View>
        </>}
        <Pressable accessibilityRole="button" accessibilityLabel={submitLabel} disabled={busy || !ready}
          onPress={() => void submit()} style={[s.button, s.primary, (busy || !ready) && s.disabled]}>
          {busy ? <ActivityIndicator color="#FFF" /> : <Text style={s.buttonText}>{submitLabel}</Text>}
        </Pressable>
        {!!error && <Text accessibilityRole="alert" style={s.error}>{error}</Text>}
      </View>
    </ScrollView>
  </KeyboardAvoidingView>;
}

const s = StyleSheet.create({
  welcome: { flex: 1, backgroundColor: maroon, paddingHorizontal: 24, alignItems: 'center', gap: 20, overflow: 'hidden' },
  logoSpace: { flex: 1, width: '100%', justifyContent: 'center', alignItems: 'center' },
  artwork: { position: 'absolute', alignSelf: 'center' },
  shape: { position: 'absolute' },
  arch: { backgroundColor: '#731E17', right: '-12%', top: '-8%', transform: [{rotate: '-32deg'}] },
  peach: { backgroundColor: '#944438', right: '-6%', bottom: '-7%' },
  accent: { backgroundColor: '#D28470', left: '12%', top: '74%' },
  wordmark: { color: ivory, fontWeight: '700' },
  logoDot: { color: '#F0A48A' },
  actions: { width: '100%', maxWidth: 430, gap: 12 },
  button: { minHeight: 54, borderRadius: 28, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  buttonText: { fontSize: 17, color: ivory, fontWeight: '600' },
  welcomePrimary: { backgroundColor: ivory },
  welcomePrimaryText: { fontSize: 17, fontWeight: '600', color: maroon },
  welcomeSecondary: { borderWidth: 1, borderColor: ivory },
  page: { flex: 1, backgroundColor: ivory },
  body: { flexGrow: 1, alignItems: 'center', paddingHorizontal: 22 },
  form: { width: '100%', maxWidth: 400, gap: 12 },
  back: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#FFF', alignItems: 'center', justifyContent: 'center' },
  title: { color: maroon, fontSize: 32, fontWeight: '500', marginTop: 10, marginBottom: 5 },
  copy: { color: muted, fontSize: 14, lineHeight: 20 },
  input: { minHeight: 56, borderRadius: 17, borderWidth: 1, borderColor: '#DCCAC1', paddingHorizontal: 16, backgroundColor: '#FFF', color: '#271D19', fontSize: 16 },
  passwordRow: { minHeight: 56, flexDirection: 'row', alignItems: 'center', borderRadius: 17, borderWidth: 1, borderColor: '#DCCAC1', backgroundColor: '#FFF' },
  passwordInput: { flex: 1, minWidth: 0, minHeight: 54, paddingHorizontal: 16, color: '#271D19', fontSize: 16 },
  passwordToggle: { width: 52, minHeight: 52, alignItems: 'center', justifyContent: 'center' },
  termsRow: { flexDirection: 'row', alignItems: 'center' },
  termsText: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 4 },
  termsCopy: { color: '#271D19', fontSize: 13 },
  termsLink: { color: maroon, fontSize: 13, textDecorationLine: 'underline' },
  checkboxTarget: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: '#C6BAB4', alignItems: 'center', justifyContent: 'center' },
  checkboxOn: { backgroundColor: maroon, borderColor: maroon },
  primary: { backgroundColor: maroon, marginTop: 4 },
  disabled: { opacity: 0.55 },
  error: { color: '#A23B30', fontSize: 14 },
});
