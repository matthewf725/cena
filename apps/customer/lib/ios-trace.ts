import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

export type MealTraceEvent = 'boot' | 'meal-tap' | 'recent-tap' | 'detail-requested' | 'detail-rendered'
  | 'detail-layout' | 'detail-frame' | 'detail-close' | 'detail-add' | 'detail-error';

type NativeManifest = { manifest?: unknown; manifestString?: string };
let traceKey: string | null | undefined;
let sequence = 0;
const session = Math.random().toString(36).slice(2).padEnd(10, '0');
const endpoint = 'https://cena-calpoly-ios.trustworthybasket2.chatgpt.site/v1/ios-trace';

function getTraceKey(): string | null {
  if (Platform.OS !== 'ios') return null;
  if (traceKey !== undefined) return traceKey;
  traceKey = null;
  try {
    const updates = requireOptionalNativeModule<NativeManifest>('ExpoUpdates');
    const constants = requireOptionalNativeModule<NativeManifest>('ExponentConstants');
    for (const value of [updates?.manifest, updates?.manifestString, constants?.manifest]) {
      if (!value) continue;
      const manifest = typeof value === 'string' ? JSON.parse(value) : value;
      const key = manifest?.extra?.expoClient?.extra?.cenaItemTrace ?? manifest?.extra?.cenaItemTrace;
      if (typeof key === 'string' && /^[a-f0-9]{32}$/.test(key)) { traceKey = key; break; }
    }
  } catch { /* Diagnostics never interrupt the normal preview. */ }
  return traceKey;
}

export const iosTraceEnabled = () => getTraceKey() !== null;

export async function traceMeal(event: MealTraceEvent): Promise<void> {
  const key = getTraceKey();
  if (!key) return;
  try {
    await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, session, sequence: ++sequence, event }),
    });
  } catch { /* Never hold an interaction for a failed trace. */ }
}
