import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { Check, Soup } from 'lucide-react-native';
import { Text, TextInput } from './type';
import { demoKitchenEquipment, saveDemoPreviewProfile, type DemoPreviewProfile } from '../lib/demo-profile';

type SeedProfile = { display_name: string; equipment: string[]; phone?: string };

export function DemoProfile({ profile, topSpace, bottomSpace, loading, retry, onProfileSaved, settingsMode }: {
  profile?: SeedProfile;
  topSpace: number;
  bottomSpace: number;
  loading: boolean;
  retry: () => void;
  onProfileSaved?: (profile: DemoPreviewProfile) => void;
  settingsMode?: boolean;
}) {
  const [name, setName] = useState(profile?.display_name ?? '');
  const [phone, setPhone] = useState(profile?.phone ?? '');
  const [equipment, setEquipment] = useState<string[]>(profile?.equipment ?? []);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const seedName = profile?.display_name ?? '';
  const seedPhone = profile?.phone ?? '';
  const seedEquipment = (profile?.equipment ?? []).join('\u0000');

  useEffect(() => {
    if (!profile) return;
    setName(seedName);
    setPhone(seedPhone);
    setEquipment(seedEquipment ? seedEquipment.split('\u0000') : []);
  }, [seedName, seedPhone, seedEquipment]);

  function toggleEquipment(item: string) {
    setEquipment(current => current.includes(item) ? current.filter(value => value !== item) : [...current, item]);
    setMessage('');
    setError('');
  }

  function startEdit() {
    setName(seedName);
    setPhone(seedPhone);
    setEquipment(seedEquipment ? seedEquipment.split('\u0000') : []);
    setMessage('');
    setError('');
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const saved = await saveDemoPreviewProfile({ display_name: name, phone, equipment });
      setName(saved.display_name);
      setPhone(saved.phone);
      setEquipment(saved.equipment);
      onProfileSaved?.(saved);
      setEditing(false);
      setMessage('Profile saved.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save your profile. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled"
    contentContainerStyle={[styles.content, { paddingTop: topSpace + 20, paddingBottom: bottomSpace }]}>
    {!settingsMode && <Text accessibilityRole="header" style={styles.title}>Your profile</Text>}
    {profile ? <>
      <View style={styles.field}>
        <Text style={styles.label}>Name</Text>
        {editing ? <TextInput accessibilityLabel="Your name" value={name} onChangeText={value => { setName(value); setMessage(''); setError(''); }}
          autoCapitalize="words" maxLength={60} placeholder="Your name" style={styles.input} editable={!saving}/>
          : <Text style={styles.staticValue}>{name}</Text>}
      </View>
      <View style={styles.field}>
        <Text style={styles.label}>Phone number</Text>
        {editing ? <TextInput accessibilityLabel="Phone number" value={phone} onChangeText={value => { setPhone(value); setMessage(''); setError(''); }}
          autoComplete="tel" textContentType="telephoneNumber" keyboardType="phone-pad" maxLength={32}
          placeholder="Optional" style={styles.input} editable={!saving}/>
          : <Text style={styles.staticValue}>{phone || 'No phone number added'}</Text>}
      </View>
      <View style={styles.equipmentBlock}>
        <View style={styles.equipmentHeading}>
          <Soup size={19} color={maroon} aria-hidden/>
          <Text style={styles.label}>Kitchen equipment you have</Text>
        </View>
        {editing ? <View style={styles.chips}>
          {demoKitchenEquipment.map(item => {
            const selected = equipment.includes(item);
            return <Pressable key={item} accessibilityRole="checkbox" accessibilityLabel={item} disabled={saving}
              accessibilityState={{ checked: selected, disabled: saving }} onPress={() => toggleEquipment(item)}
              style={[styles.chip, selected && styles.chipSelected]}>
              {selected && <Check size={14} color={maroon} aria-hidden/>}
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{item}</Text>
            </Pressable>;
          })}
        </View> : <Text style={styles.equipmentValue}>{equipment.length ? equipment.join(', ') : 'No equipment selected'}</Text>}
      </View>
      {loading && <View style={styles.loadingRow}><ActivityIndicator color={maroon}/><Text style={styles.detail}>Loading demo profile…</Text></View>}
      {!!error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
      {!!message && <Text accessibilityLiveRegion="polite" style={styles.saved}>{message}</Text>}
      {editing ? <>
        <Pressable accessibilityRole="button" accessibilityLabel="Save profile" disabled={saving || loading || !name.trim()}
          onPress={() => void save()} style={[styles.button, (saving || loading || !name.trim()) && styles.buttonDisabled]}>
          <Text style={styles.buttonText}>{saving ? 'Saving…' : 'Save profile'}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={saving} onPress={() => {
          setName(seedName);
          setPhone(seedPhone);
          setEquipment(seedEquipment ? seedEquipment.split('\u0000') : []);
          setError('');
          setEditing(false);
        }} style={styles.secondary}>
          <Text style={styles.secondaryText}>Cancel</Text>
        </Pressable>
      </> : <Pressable accessibilityRole="button" disabled={loading} onPress={startEdit} style={[styles.button, loading && styles.buttonDisabled]}>
        <Text style={styles.buttonText}>Edit profile</Text>
      </Pressable>}
    </> : loading ? <View style={styles.loadingRow}><ActivityIndicator color={maroon} accessibilityLabel="Loading demo profile"/><Text style={styles.detail}>Loading demo profile…</Text></View> : <>
      <Text style={styles.detail}>Couldn’t load the demo profile.</Text>
      <Pressable accessibilityRole="button" style={styles.button} onPress={retry}><Text style={styles.buttonText}>Try again</Text></Pressable>
    </>}
  </ScrollView>;
}

const maroon = '#5D100A';
const ink = '#271D19';
const muted = '#77645B';
const line = '#E8DCD5';
const styles = StyleSheet.create({
  content: { paddingHorizontal: 22, gap: 14 },
  title: { color: ink, fontSize: 30, fontWeight: '500', marginBottom: 1 },
  field: { gap: 7 },
  label: { color: ink, fontSize: 14, fontWeight: '600' },
  staticValue: { color: muted, fontSize: 16 },
  equipmentValue: { color: muted, fontSize: 16, marginTop: 7 },
  input: { minHeight: 48, borderWidth: 1, borderColor: line, borderRadius: 12, backgroundColor: '#FFFDFB', paddingHorizontal: 13, color: ink, fontSize: 16 },
  secondary: { minHeight: 44, borderWidth: 1, borderColor: line, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  secondaryText: { color: maroon, fontSize: 16, fontWeight: '500' },
  equipmentBlock: { padding: 14, borderRadius: 16, borderWidth: 1, borderColor: line, backgroundColor: '#FFFDFB' },
  equipmentHeading: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  detail: { color: muted, fontSize: 13, lineHeight: 19, marginTop: 4 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  chip: { minHeight: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingHorizontal: 12, borderRadius: 20, borderWidth: 1, borderColor: line, backgroundColor: '#FFFDFA' },
  chipSelected: { borderColor: '#C9A29A', backgroundColor: '#F6EBE6' },
  chipText: { color: ink, fontSize: 13 },
  chipTextSelected: { color: maroon, fontWeight: '500' },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  button: { minHeight: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: maroon, marginTop: 2 },
  buttonDisabled: { opacity: 0.48 },
  buttonText: { color: '#FFF', fontSize: 15, fontWeight: '600' },
  saved: { color: '#245C40', fontSize: 13, fontWeight: '500' },
  error: { color: '#A23B30', fontSize: 13, lineHeight: 19 },
});
