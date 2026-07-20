export const SUPABASE_URL = 'https://feronxsrxawcxhjllpxg.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY =
  'sb_publishable_S_JknkWrscDQu-NrRc8q1Q_1ip7OyId';
export const REWIND_PROXY_URL =
  'https://rewind-proxy-236465589949.us-west2.run.app';

export const AI_MODE = (process.env.NEXT_PUBLIC_AI_MODE ?? 'local') as string;
export const isCloud = AI_MODE === 'cloud';
