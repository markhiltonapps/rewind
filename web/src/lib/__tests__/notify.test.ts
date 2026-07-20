import { describe, it, expect, vi } from 'vitest';
import { processNotify } from '../notify';
describe('processNotify', () => {
  it('valid → ok + write', async () => {
    const addMac = vi.fn().mockResolvedValue(undefined);
    expect(await processNotify(' X@Y.CO ', { addMac })).toEqual({ status: 'ok' });
    expect(addMac).toHaveBeenCalledWith('x@y.co');
  });
  it('invalid → invalid, no write', async () => {
    const addMac = vi.fn();
    expect(await processNotify('bad', { addMac })).toEqual({ status: 'invalid' });
    expect(addMac).not.toHaveBeenCalled();
  });
  it('throws → error', async () => {
    const addMac = vi.fn().mockRejectedValue(new Error('x'));
    expect(await processNotify('x@y.co', { addMac })).toEqual({ status: 'error' });
  });
});
