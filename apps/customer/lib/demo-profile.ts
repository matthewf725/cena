import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

const tokenKey = 'cena.cal-poly-preview-profile.v1';

export const demoKitchenEquipment = ['Oven', 'Stovetop', 'Microwave', 'Air fryer', 'Toaster', 'Panini press'] as const;

export type DemoPreviewProfile = {
  display_name: string;
  phone: string;
  equipment: string[];
};

function normalizeProfile(value: unknown): DemoPreviewProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const profile = value as Record<string, unknown>;
  if (typeof profile.display_name !== 'string' || typeof profile.phone !== 'string' || !Array.isArray(profile.equipment)) return null;
  const display_name = profile.display_name.trim().slice(0, 60);
  if (!display_name) return null;
  const equipment = [...new Set(profile.equipment.filter((item): item is string =>
    typeof item === 'string' && (demoKitchenEquipment as readonly string[]).includes(item)))];
  return { display_name, phone: profile.phone.trim().slice(0, 32), equipment };
}

export async function loadDemoPreviewProfile(): Promise<DemoPreviewProfile | null> {
  const token = await AsyncStorage.getItem(tokenKey);
  if (!token) return null;
  if (!/^[a-f0-9]{64}$/.test(token)) {
    await AsyncStorage.removeItem(tokenKey);
    return null;
  }
  if (!supabase) throw new Error('Profile storage is unavailable. Check your connection and try again.');
  const { data, error } = await supabase.rpc('get_cal_poly_preview_profile', { p_token: token });
  if (error) throw error;
  const profile = normalizeProfile(data?.profile);
  if (!profile) throw new Error('Your saved demo profile could not be read. Try again.');
  return profile;
}

export async function saveDemoPreviewProfile(input: DemoPreviewProfile): Promise<DemoPreviewProfile> {
  const profile = normalizeProfile(input);
  if (!profile) throw new Error('Enter your name to save your profile.');
  if (!supabase) throw new Error('Profile storage is unavailable. Check your connection and try again.');
  const existingToken = await AsyncStorage.getItem(tokenKey);
  const token = existingToken && /^[a-f0-9]{64}$/.test(existingToken) ? existingToken : null;
  const { data, error } = await supabase.rpc('save_cal_poly_preview_profile', {
    p_token: token,
    p_display_name: profile.display_name,
    p_phone: profile.phone,
    p_equipment: profile.equipment,
  });
  if (error) throw error;
  const nextToken = data?.token;
  const saved = normalizeProfile(data?.profile);
  if (typeof nextToken !== 'string' || !/^[a-f0-9]{64}$/.test(nextToken) || !saved) {
    throw new Error('Your profile could not be confirmed as saved. Try again.');
  }
  await AsyncStorage.setItem(tokenKey, nextToken);
  return saved;
}
