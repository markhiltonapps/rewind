import { NextResponse } from 'next/server';
import { processSignup } from '@/lib/signup';
import { signupDeps } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let email = '';
  try { email = (await req.json())?.email ?? ''; } catch { /* empty */ }
  const result = await processSignup(email, signupDeps());
  const code = result.status === 'invalid' ? 400 : result.status === 'error' ? 500 : 200;
  return NextResponse.json(result, { status: code });
}
