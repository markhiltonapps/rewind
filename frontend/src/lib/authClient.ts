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

// Push the current Supabase session token to the Rust layer immediately.
// Called unconditionally on app startup (not gated on isCloud) so that the
// Rust transcription path always has a token even when the frontend thinks
// it's in local mode but the backend is actually running in cloud mode.
export async function syncTokenToRust(): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token ?? null;
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('set_auth_token', { token: token ?? '' });
  } catch { /* ignore — command may not be wired yet */ }
}

export function onAuth(cb: (token: string | null) => void): () => void {
  // Eagerly push the current session to Rust right away instead of waiting
  // for onAuthStateChange (which fires asynchronously). Without this, any
  // recording that ends between app startup and the first state-change event
  // sends no auth header and gets a 401 from the cloud backend.
  syncTokenToRust();

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
