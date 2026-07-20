import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './cloudConfig';

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});

export async function sendCode(email: string): Promise<{ error: string | null }> {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true },
  });
  return { error: error?.message ?? null };
}

export async function verifyCode(
  email: string,
  code: string
): Promise<{ error: string | null }> {
  const { error } = await supabase.auth.verifyOtp({
    email,
    token: code,
    type: 'email',
  });
  return { error: error?.message ?? null };
}

export async function getAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

export async function signOut(): Promise<void> {
  await supabase.auth.signOut();
}

export function onAuth(cb: (token: string | null) => void): () => void {
  const { data } = supabase.auth.onAuthStateChange(async (_event, session) => {
    const token = session?.access_token ?? null;
    cb(token);
    // Push token to Rust side — swallow errors if command not yet wired.
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('set_auth_token', { token: token ?? '' });
    } catch {
      // Command may not exist yet; ignore.
    }
  });
  return () => data.subscription.unsubscribe();
}
