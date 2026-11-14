import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Check } from 'lucide-react-native';
import { demoKitchenEquipment } from '../lib/demo-profile';
import { loadCustomerAccount, saveCustomerAccount, signOutCustomer, type CustomerProfile } from '../lib/profile';
import { Text, TextInput } from './type';

type Props = {
  userId: string | null;
  topSpace: number;
  bottomSpace?: number;
  settingsMode?: boolean;
  equipment: string[]; setEquipment: (value: string[]) => void;
  email: string; setEmail: (value: string) => void;
  phone: string; setPhone: (value: string) => void;
  displayName: string; setDisplayName: (value: string) => void;
  onProfileSaved: () => void;
};

export function Account(props: Props) {
  const [loaded, setLoaded] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(props.userId));
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<CustomerProfile | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const activeUserId = useRef(props.userId);
  activeUserId.current = props.userId;

  useEffect(() => {
    const userId = props.userId;
    let current = true;
    setLoaded(null);
    setDraft(null);
    setMessage('');
    setError('');
    if (!userId) { setLoading(false); return; }
    setLoading(true);
    void loadCustomerAccount().then(account => {
      if (!current) return;
      if (account?.userId !== userId || activeUserId.current !== userId) throw new Error('Couldn’t load your profile.');
      props.setEmail(account.email);
      props.setDisplayName(account.profile.displayName);
      props.setPhone(account.profile.phone);
      props.setEquipment(account.profile.equipment);
      setLoaded(userId);
    }).catch(() => {
      if (current) setError('Couldn’t load your profile. Try again.');
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [props.userId, retry]);

  function edit() {
    setMessage('');
    setError('');
    setDraft({ displayName: props.displayName, phone: props.phone, equipment: props.equipment });
  }

  async function save() {
    const userId = props.userId;
    if (!userId || loaded !== userId || busy || !draft) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await saveCustomerAccount(draft, userId);
      if (activeUserId.current === userId) {
        props.setDisplayName(draft.displayName.trim());
        props.setPhone(draft.phone.trim());
        props.setEquipment(draft.equipment);
        props.onProfileSaved();
        setDraft(null);
        setMessage('Profile saved.');
      }
    } catch {
      setError('Couldn’t save your profile. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    if (!props.userId || busy) return;
    setBusy(true);
    setMessage('');
    setError('');
    try { await signOutCustomer(); }
    catch { setError('Couldn’t sign out. Try again.'); }
    finally { setBusy(false); }
  }

  const signedIn = !!props.userId && loaded === props.userId;
  const locked = busy || !signedIn;
  return <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled"
    contentContainerStyle={[styles.content, { paddingTop: props.topSpace + 20, paddingBottom: props.bottomSpace ?? 24 }]}>
    {!props.settingsMode && <Text accessibilityRole="header" style={styles.title}>Profile</Text>}
    {loading ? <ActivityIndicator color={maroon} accessibilityLabel="Loading profile"/> : signedIn ? <>
      <View style={styles.field}>
        <Text style={styles.label}>Name</Text>
        {draft ? <TextInput accessibilityLabel="Your name" style={styles.input} value={draft.displayName}
          onChangeText={displayName => setDraft({ ...draft, displayName })} autoCapitalize="words" maxLength={80} editable={!locked}/>
          : <Text style={styles.staticValue}>{props.displayName || 'No name added'}</Text>}
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Email</Text>
        <Text selectable style={styles.staticValue}>{props.email}</Text>
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Mobile number</Text>
        {draft ? <TextInput accessibilityLabel="Mobile number" style={styles.input} value={draft.phone}
          onChangeText={phone => setDraft({ ...draft, phone })} keyboardType="phone-pad" autoComplete="tel"
          maxLength={32} placeholder="Optional" placeholderTextColor={muted} editable={!locked}/>
          : <Text style={styles.staticValue}>{props.phone || 'No mobile number added'}</Text>}
      </View>
      <View style={styles.field}>
        <Text accessibilityRole="header" style={styles.label}>Kitchen equipment you have</Text>
        {draft ? <View style={styles.chips}>{demoKitchenEquipment.map(item => {
          const checked = draft.equipment.includes(item);
          return <Pressable key={item} disabled={locked} accessibilityRole="checkbox" accessibilityLabel={item}
            accessibilityState={{ checked, disabled: locked }} onPress={() => setDraft({ ...draft, equipment:
              checked ? draft.equipment.filter(value => value !== item) : [...draft.equipment, item],
            })} style={[styles.chip, checked && styles.chipOn]}>
            {checked && <Check size={15} color={maroon} aria-hidden/>}
            <Text style={[styles.chipText, checked && styles.selected]}>{item}</Text>
          </Pressable>;
        })}</View> : <Text style={styles.staticValue}>{props.equipment.length ? props.equipment.join(', ') : 'No equipment selected'}</Text>}
      </View>
      {draft ? <>
        <Pressable accessibilityRole="button" disabled={locked} onPress={() => void save()} style={[styles.primary, locked && styles.disabled]}>
          <Text style={styles.primaryText}>{busy ? 'Saving…' : 'Save profile'}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={locked} onPress={() => { setDraft(null); setError(''); }} style={styles.secondary}>
          <Text style={styles.secondaryText}>Cancel</Text>
        </Pressable>
      </> : <Pressable accessibilityRole="button" onPress={edit} style={styles.primary}>
        <Text style={styles.primaryText}>Edit profile</Text>
      </Pressable>}
    </> : !!props.userId && <Pressable accessibilityRole="button" onPress={() => setRetry(current => current + 1)} style={styles.primary}>
      <Text style={styles.primaryText}>Try loading again</Text>
    </Pressable>}
    {!!props.userId && !draft && <Pressable accessibilityRole="button" disabled={busy} onPress={() => void signOut()} style={styles.secondary}>
      <Text style={styles.secondaryText}>Sign out</Text>
    </Pressable>}
    {!!message && <Text accessibilityLiveRegion="polite" style={styles.message}>{message}</Text>}
    {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
  </ScrollView>;
}

const maroon = '#5D100A';
const ink = '#271D19';
const muted = '#77645B';
const line = '#E8DCD5';
const styles = StyleSheet.create({
  content: { paddingHorizontal: 22, gap: 18 },
  title: { color: ink, fontSize: 27, fontWeight: '600' },
  field: { gap: 8 },
  label: { color: ink, fontSize: 16, fontWeight: '600' },
  input: { minHeight: 48, borderWidth: 1, borderColor: line, borderRadius: 12, backgroundColor: '#FFFDFB', paddingHorizontal: 13, color: ink, fontSize: 16 },
  staticValue: { color: muted, fontSize: 16 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 },
  chip: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, borderRadius: 22, borderWidth: 1, borderColor: line, backgroundColor: '#FFFDFB' },
  chipOn: { borderColor: '#B77A6E', backgroundColor: '#F7EDE7' },
  chipText: { color: ink, fontSize: 14 },
  selected: { color: maroon },
  primary: { minHeight: 48, borderRadius: 12, backgroundColor: maroon, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: '#FFF', fontSize: 16, fontWeight: '600' },
  secondary: { minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: line, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: maroon, fontSize: 16, fontWeight: '500' },
  disabled: { opacity: 0.55 },
  message: { color: '#245C40', fontSize: 14, textAlign: 'center' },
  error: { color: '#A23B30', fontSize: 14, textAlign: 'center' },
});
