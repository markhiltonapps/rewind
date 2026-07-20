import { isValidEmail, normalizeEmail } from './email';
export interface NotifyDeps { addMac(email: string): Promise<void>; }
export type NotifyResult = { status: 'ok' | 'invalid' | 'error' };
export async function processNotify(email: string, deps: NotifyDeps): Promise<NotifyResult> {
  if (!isValidEmail(email)) return { status: 'invalid' };
  try { await deps.addMac(normalizeEmail(email)); return { status: 'ok' }; }
  catch { return { status: 'error' }; }
}
