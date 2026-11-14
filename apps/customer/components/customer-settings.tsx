import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BackHandler, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { ArrowLeft, Check, ChevronRight, MapPin, Trash2 } from 'lucide-react-native';
import { loadCustomerAnalyticsConsent } from '../lib/profile';
import { saveAnalyticsConsent } from '../lib/supabase';
import type { OrderBadgePreference } from '../lib/order-badge-preference';
import { HeaderButton, PageHeader } from './home-chrome';
import { Text } from './type';

type SettingsPage = 'settings' | 'manage' | 'payment' | 'address' | 'privacy' | 'notifications';
type PickupAddress = { label: string; latitude: number; longitude: number };

type Props = {
  topInset: number;
  bottomSpace: number;
  reduced: boolean;
  userId: string | null;
  locationLabel: string;
  recentAddresses: PickupAddress[];
  addressPickerOpen?: boolean;
  onClose: () => void;
  onOpenAddress: () => void;
  onSelectAddress: (address: PickupAddress) => void;
  onRemoveAddress: (label: string) => void;
  onOpenOrders: () => void;
  onOpenBag: () => void;
  manageAccount: () => ReactNode;
  analyticsConsented: boolean;
  setAnalyticsConsented: (value: boolean) => void;
  orderBadge: OrderBadgePreference;
};

const title: Record<SettingsPage, string> = {
  settings: 'Settings',
  manage: 'Manage account',
  payment: 'Payment',
  address: 'Address',
  privacy: 'Privacy',
  notifications: 'Notifications',
};

const sections = [
  ['manage', 'Update your details and kitchen equipment'],
  ['payment', 'Checkout and payment history'],
  ['address', 'Add or remove pickup addresses'],
  ['privacy', 'Manage your data and privacy settings'],
  ['notifications', 'Manage your upcoming pickup badge'],
] as const;

export function CustomerSettings(props: Props) {
  const [page, setPage] = useState<SettingsPage>('settings');
  const goBack = () => page === 'settings' ? props.onClose() : setPage('settings');
  const backRef = useRef(goBack);
  backRef.current = goBack;
  useEffect(() => {
    if (Platform.OS !== 'android' || props.addressPickerOpen) return;
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      backRef.current();
      return true;
    });
    return () => handler.remove();
  }, [props.addressPickerOpen]);

  return <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <PageHeader identityHeight={58} topInset={props.topInset}>
      <View style={styles.toolbar}>
        <HeaderButton label={page === 'settings' ? 'Close settings' : 'Back to settings'}
          onPress={goBack} reduced={props.reduced}><ArrowLeft size={22} color={maroon} aria-hidden/></HeaderButton>
        <Text accessibilityRole="header" style={styles.screenTitle} numberOfLines={1}>{title[page]}</Text>
        <View style={styles.toolbarSpacer} aria-hidden/>
      </View>
    </PageHeader>
    {page === 'manage' ? props.manageAccount() : <ScrollView key={page} style={styles.scroll}
      showsVerticalScrollIndicator={false} contentContainerStyle={[styles.content, { paddingBottom: props.bottomSpace }]}>
      {page === 'settings' && <>
        <Text accessibilityRole="header" style={styles.heading}>Account settings</Text>
        {sections.map(([id, detail]) => <SettingsRow key={id} label={title[id]} detail={detail} onPress={() => setPage(id)}/>)}
      </>}
      {page === 'payment' && <>
        <Text style={styles.lead}>Choose your payment method at secure checkout. Find payment and refund details in your orders.</Text>
        <SettingsRow label="Payment history" onPress={props.onOpenOrders}/>
        <SettingsRow label="Open bag" onPress={props.onOpenBag}/>
      </>}
      {page === 'address' && <>
        <View style={styles.addressCurrent}>
          <MapPin size={21} color={maroon} aria-hidden/>
          <View style={styles.rowCopy}>
            <Text style={styles.smallLabel}>Current pickup area</Text>
            <Text style={styles.rowLabel}>{props.locationLabel}</Text>
          </View>
        </View>
        <SettingsRow label="Add an address" detail="Search for a street address or use your location" onPress={props.onOpenAddress}/>
        {props.recentAddresses.length > 0 && <>
          <Text accessibilityRole="header" style={styles.subheading}>Saved on this device</Text>
          {props.recentAddresses.map(address => {
            const selected = address.label === props.locationLabel;
            return <View key={address.label} style={styles.addressRow}>
              <Pressable accessibilityRole="button" accessibilityLabel={address.label} accessibilityState={{ selected }}
                style={({ pressed }) => [styles.addressPick, pressed && styles.pressed]}
                onPress={() => props.onSelectAddress(address)}>
                {selected ? <Check size={18} color={maroon} aria-hidden/> : <MapPin size={18} color={maroon} aria-hidden/>}
                <Text style={[styles.addressLabel, selected && styles.selected]}>{address.label}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" accessibilityLabel={`Remove ${address.label}`}
                style={({ pressed }) => [styles.removeAddress, pressed && styles.pressed]}
                onPress={() => props.onRemoveAddress(address.label)}>
                <Trash2 size={18} color={maroon} aria-hidden/>
              </Pressable>
            </View>;
          })}
        </>}
      </>}
      {page === 'privacy' && <PrivacySettings key={props.userId ?? 'guest'} userId={props.userId}
        analyticsConsented={props.analyticsConsented} setAnalyticsConsented={props.setAnalyticsConsented}/>}
      {page === 'notifications' && <>
        <SwitchRow label="Upcoming pickup badge" detail="Show the number of upcoming pickups on the Orders tab"
          enabled={props.orderBadge.enabled} loading={props.orderBadge.loading} change={props.orderBadge.update}/>
        {!!props.orderBadge.error && <Text accessibilityRole="alert" style={styles.error}>{props.orderBadge.error}</Text>}
      </>}
    </ScrollView>}
  </KeyboardAvoidingView>;
}

function SettingsRow({ label, detail, onPress, role = 'button' }: {
  label: string; detail?: string; onPress: () => void; role?: 'button' | 'link';
}) {
  return <Pressable accessibilityRole={role} accessibilityLabel={label} accessibilityHint={detail} onPress={onPress}
    style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
    <View style={styles.rowCopy}>
      <Text style={styles.rowLabel}>{label}</Text>
      {detail && <Text style={styles.rowDetail}>{detail}</Text>}
    </View>
    <ChevronRight size={22} color={maroon} aria-hidden/>
  </Pressable>;
}

function SwitchRow({ label, detail, enabled, loading, change }: {
  label: string; detail: string; enabled: boolean; loading: boolean; change: (enabled: boolean) => void;
}) {
  return <View style={styles.row}>
    <View style={styles.rowCopy}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowDetail}>{detail}</Text>
    </View>
    <Switch accessibilityLabel={label} accessibilityHint={detail} trackColor={{ false: '#D0C6BF', true: maroon }}
      value={enabled} disabled={loading} onValueChange={change}/>
  </View>;
}

function PrivacySettings({ userId, analyticsConsented, setAnalyticsConsented }: {
  userId: string | null; analyticsConsented: boolean; setAnalyticsConsented: (value: boolean) => void;
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'saving' | 'failed'>(userId ? 'loading' : 'ready');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const busy = useRef(false);
  const setConsent = useRef(setAnalyticsConsented);
  setConsent.current = setAnalyticsConsented;

  useEffect(() => {
    if (!userId) return;
    let current = true;
    setError('');
    setStatus('loading');
    void loadCustomerAnalyticsConsent(userId).then(enabled => {
      if (!current) return;
      setConsent.current(enabled);
      setStatus('ready');
    }).catch(() => {
      if (!current) return;
      setStatus('failed');
      setError('Couldn’t load your privacy choice.');
    });
    return () => { current = false; };
  }, [userId, retry]);

  async function changeAnalytics(enabled: boolean) {
    if (!userId || status !== 'ready' || busy.current) return;
    busy.current = true;
    setStatus('saving');
    setError('');
    try {
      const { error: saveError } = await saveAnalyticsConsent(enabled, userId);
      if (saveError) throw saveError;
      setAnalyticsConsented(enabled);
    } catch {
      setError('Couldn’t save your privacy choice. Try again.');
    } finally {
      busy.current = false;
      setStatus('ready');
    }
  }

  async function openPolicy(path: 'privacy.html' | 'privacy.html#privacy-request-form' | 'terms.html') {
    setError('');
    const site = process.env.EXPO_PUBLIC_CENA_SITE_URL || 'https://cena-xi.vercel.app';
    try { await Linking.openURL(new URL(path, site.replace(/\/?$/, '/')).href); }
    catch { setError('Couldn’t open that page. Try again.'); }
  }

  return <>
    {userId ? <SwitchRow label="Share anonymous usage data"
      detail="Allow optional browsing analytics to help improve Cena"
      enabled={analyticsConsented} loading={status !== 'ready'} change={value => void changeAnalytics(value)}/>
      : <Text style={styles.lead}>Optional browsing analytics are off in this preview.</Text>}
    {status === 'failed' && <SettingsRow label="Reload privacy choice" onPress={() => setRetry(current => current + 1)}/>}
    <SettingsRow label="Privacy policy" role="link" onPress={() => void openPolicy('privacy.html')}/>
    <SettingsRow label="Submit a privacy request" role="link" onPress={() => void openPolicy('privacy.html#privacy-request-form')}/>
    <SettingsRow label="Consumer terms" role="link" onPress={() => void openPolicy('terms.html')}/>
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  </>;
}

const maroon = '#5D100A';
const ink = '#271D19';
const muted = '#77645B';
const line = '#E8DCD5';
const styles = StyleSheet.create({
  screen: { flex: 1 },
  scroll: { flex: 1 },
  toolbar: { height: 58, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 18, gap: 12 },
  toolbarSpacer: { width: 44 },
  screenTitle: { flex: 1, textAlign: 'center', fontSize: 23, fontWeight: '700', color: ink },
  content: { paddingHorizontal: 22, paddingTop: 9 },
  heading: { fontSize: 27, fontWeight: '700', color: ink, marginTop: 16, marginBottom: 9 },
  subheading: { color: ink, fontSize: 18, fontWeight: '600', marginTop: 23, marginBottom: 8 },
  lead: { color: muted, fontSize: 17, lineHeight: 24, paddingVertical: 14 },
  row: { minHeight: 70, flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#C9BBB3', gap: 13 },
  rowCopy: { flex: 1, minWidth: 0, gap: 4 },
  rowLabel: { color: ink, fontSize: 20, fontWeight: '600' },
  rowDetail: { color: muted, fontSize: 16, lineHeight: 21 },
  pressed: { backgroundColor: '#F3E7DF' },
  smallLabel: { color: muted, fontSize: 15 },
  addressCurrent: { backgroundColor: '#FFFDFB', borderRadius: 16, borderWidth: 1, borderColor: line, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  addressRow: { flexDirection: 'row', alignItems: 'stretch', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: line },
  addressPick: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 50, gap: 8, paddingVertical: 8 },
  addressLabel: { color: ink, fontSize: 16, flex: 1 },
  selected: { color: maroon, fontWeight: '600' },
  removeAddress: { width: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  error: { color: '#A23B30', fontSize: 15, marginTop: 12 },
});
