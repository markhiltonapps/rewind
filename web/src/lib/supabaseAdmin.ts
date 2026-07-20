import { createClient } from '@supabase/supabase-js';
import type { SignupDeps } from './signup';

// Read an env var and strip surrounding whitespace. Values set via some
// CLIs/pipes can pick up a trailing newline; an unnoticed "\n" on the
// service-role key silently breaks the Authorization header (401 -> 500).
function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v.trim();
}

function admin() {
  const url = env('SUPABASE_URL');
  const key = env('SUPABASE_SERVICE_ROLE_KEY'); // server-only
  return createClient(url, key, { auth: { persistSession: false } });
}

export function signupDeps(): SignupDeps {
  const sb = admin();
  return {
    async countInvites() {
      const { count, error } = await sb.from('invites').select('email', { count: 'exact', head: true });
      if (error) throw error;
      return count ?? 0;
    },
    async maxInvited() {
      const { data, error } = await sb.from('site_limits').select('max_invited').eq('id', 1).single();
      if (error) throw error;
      return data.max_invited as number;
    },
    async addInvite(email) {
      const { error } = await sb.from('invites').upsert({ email }, { onConflict: 'email', ignoreDuplicates: true });
      if (error) throw error;
    },
    async addOverflow(email) {
      const { error } = await sb.from('overflow_waitlist').upsert({ email }, { onConflict: 'email', ignoreDuplicates: true });
      if (error) throw error;
    },
    downloadUrl: env('DOWNLOAD_WINDOWS_URL'),
  };
}

export function macNotify() {
  const sb = admin();
  return async (email: string) => {
    const { error } = await sb.from('mac_waitlist').upsert({ email }, { onConflict: 'email', ignoreDuplicates: true });
    if (error) throw error;
  };
}
