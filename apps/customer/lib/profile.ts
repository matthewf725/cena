import { supabase } from './supabase';

export type CustomerProfile = { displayName: string; phone: string; equipment: string[] };
export type CustomerAccount = { userId: string; email: string; profile: CustomerProfile; analyticsConsented: boolean };

function client() {
  if (!supabase) throw new Error('Supabase is not configured. You can still use Cena as a guest.');
  return supabase;
}

export async function sendCustomerSignInCode(email: string) {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) throw new Error('Enter a valid email address.');
  const { error } = await client().auth.signInWithOtp({ email: normalized });
  if (error) throw error;
}

export async function verifyCustomerSignInCode(email: string, token: string) {
  const normalized = email.trim().toLowerCase();
  const code = token.trim().replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) throw new Error('Enter the 6-digit code from your email.');
  const { data, error } = await client().auth.verifyOtp({ email: normalized, token: code, type: 'email' });
  if (error) throw error;
  if (!data.session) throw new Error('The code was accepted, but no session was created. Try again.');
  return data.session.user;
}

export async function signInCustomerWithPassword(email: string, password: string) {
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) throw new Error('Enter a valid email address.');
  if (!password) throw new Error('Enter your password.');
  const { data, error } = await client().auth.signInWithPassword({ email: normalized, password });
  if (error) {
    if (/invalid login credentials|email or password/i.test(error.message)) throw new Error('Email or password is incorrect.');
    throw error;
  }
  if (!data.session) throw new Error('Sign-in was accepted, but no session was created. Try again.');
  return data.session.user;
}

/** Load only the signed-in user's real backend name for lightweight UI surfaces. */
export async function loadCustomerDisplayName(expectedUserId: string): Promise<string> {
  const api = client();
  const { data: { session }, error: sessionError } = await api.auth.getSession();
  if (sessionError) throw sessionError;
  if (!session || session.user.id !== expectedUserId) throw new Error('Your account changed. Reload and try again.');

  const { data, error } = await api.from('profiles').select('display_name').eq('id', expectedUserId).maybeSingle();
  if (error) throw error;

  const { data: { session: currentSession }, error: currentSessionError } = await api.auth.getSession();
  if (currentSessionError) throw currentSessionError;
  if (!currentSession || currentSession.user.id !== expectedUserId) throw new Error('Your account changed. Reload and try again.');
  return typeof data?.display_name === 'string' ? data.display_name.trim() : '';
}

export async function loadCustomerAccount(): Promise<CustomerAccount | null> {
  const api = client();
  const { data: { session }, error: sessionError } = await api.auth.getSession();
  if (sessionError) throw sessionError;
  if (!session) return null;
  const [profileResult, consentResult] = await Promise.all([
    api.from('profiles').select('display_name,phone,equipment').eq('id', session.user.id).maybeSingle(),
    api.from('consent_records').select('consent_action').eq('user_id', session.user.id).eq('consent_type', 'analytics')
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (profileResult.error) throw profileResult.error;
  if (consentResult.error) throw consentResult.error;
  return {
    userId: session.user.id,
    email: session.user.email ?? '',
    profile: {
      displayName: profileResult.data?.display_name ?? '',
      phone: profileResult.data?.phone ?? '',
      equipment: profileResult.data?.equipment ?? [],
    },
    analyticsConsented: consentResult.data?.consent_action === 'granted',
  };
}

export async function saveCustomerAccount(profile: CustomerProfile, analyticsConsented: boolean, expectedUserId: string) {
  const api = client();
  const { data: { user }, error: userError } = await api.auth.getUser();
  if (userError) throw userError;
  if (!user || user.id !== expectedUserId) throw new Error('Your account changed. Reload the profile and try again.');
  const { error: profileError } = await api.from('profiles').upsert({
    id: user.id,
    display_name: profile.displayName.trim().slice(0, 80),
    phone: profile.phone.trim() || null,
    equipment: profile.equipment,
  }, { onConflict: 'id' });
  if (profileError) throw profileError;
  const { data: consent, error: consentReadError } = await api.from('consent_records').select('consent_action')
    .eq('user_id', user.id).eq('consent_type', 'analytics').order('created_at', { ascending: false })
    .order('id', { ascending: false }).limit(1).maybeSingle();
  if (consentReadError) throw consentReadError;
  const latest = consent?.consent_action === 'granted';
  if (!consent || latest !== analyticsConsented) {
    const { error } = await api.from('consent_records').insert({ user_id: user.id, consent_type: 'analytics', policy_version: '2026-11-13', consent_action: analyticsConsented ? 'granted' : 'revoked' });
    if (error) throw error;
  }
}

export async function signOutCustomer() {
  const { error } = await client().auth.signOut();
  if (error) throw error;
}
