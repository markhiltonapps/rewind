import { NextResponse } from 'next/server';
import { processNotify } from '@/lib/notify';
import { macNotify } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  let email = '';
  try { email = (await req.json())?.email ?? ''; } catch { /* empty */ }
  const result = await processNotify(email, { addMac: macNotify() });
  const code = result.status === 'invalid' ? 400 : result.status === 'error' ? 500 : 200;
  return NextResponse.json(result, { status: code });
}
