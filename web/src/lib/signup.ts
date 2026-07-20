import { isValidEmail, normalizeEmail } from './email';

export interface SignupDeps {
  countInvites(): Promise<number>;
  maxInvited(): Promise<number>;
  addInvite(email: string): Promise<void>;
  addOverflow(email: string): Promise<void>;
  downloadUrl: string;
}
export type SignupResult =
  | { status: 'ok'; downloadUrl: string }
  | { status: 'waitlisted' }
  | { status: 'invalid' }
  | { status: 'error' };

export async function processSignup(email: string, deps: SignupDeps): Promise<SignupResult> {
  if (!isValidEmail(email)) return { status: 'invalid' };
  const addr = normalizeEmail(email);
  try {
    const [count, max] = await Promise.all([deps.countInvites(), deps.maxInvited()]);
    if (count >= max) {
      await deps.addOverflow(addr);
      return { status: 'waitlisted' };
    }
    await deps.addInvite(addr);
    return { status: 'ok', downloadUrl: deps.downloadUrl };
  } catch {
    return { status: 'error' };
  }
}
