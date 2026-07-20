import { describe, it, expect, vi } from 'vitest';
import { processSignup, type SignupDeps } from '../signup';

function deps(over: Partial<SignupDeps> = {}): SignupDeps {
  return {
    countInvites: vi.fn().mockResolvedValue(0),
    maxInvited: vi.fn().mockResolvedValue(200),
    addInvite: vi.fn().mockResolvedValue(undefined),
    addOverflow: vi.fn().mockResolvedValue(undefined),
    downloadUrl: 'https://dl/setup.exe',
    ...over,
  };
}

describe('processSignup', () => {
  it('invalid email → invalid, no writes', async () => {
    const d = deps();
    const r = await processSignup('nope', d);
    expect(r).toEqual({ status: 'invalid' });
    expect(d.addInvite).not.toHaveBeenCalled();
  });
  it('under cap → ok + download, invites written', async () => {
    const d = deps();
    const r = await processSignup(' A@B.CO ', d);
    expect(r).toEqual({ status: 'ok', downloadUrl: 'https://dl/setup.exe' });
    expect(d.addInvite).toHaveBeenCalledWith('a@b.co');
  });
  it('at cap → waitlisted, overflow written, NOT invited', async () => {
    const d = deps({ countInvites: vi.fn().mockResolvedValue(200) });
    const r = await processSignup('a@b.co', d);
    expect(r).toEqual({ status: 'waitlisted' });
    expect(d.addOverflow).toHaveBeenCalledWith('a@b.co');
    expect(d.addInvite).not.toHaveBeenCalled();
  });
  it('db throws → error', async () => {
    const d = deps({ addInvite: vi.fn().mockRejectedValue(new Error('x')) });
    const r = await processSignup('a@b.co', d);
    expect(r).toEqual({ status: 'error' });
  });
});
