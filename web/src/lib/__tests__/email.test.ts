import { describe, it, expect } from 'vitest';
import { isValidEmail } from '../email';
describe('isValidEmail', () => {
  it('accepts a normal address', () => expect(isValidEmail('a@b.co')).toBe(true));
  it('rejects missing @', () => expect(isValidEmail('ab.co')).toBe(false));
  it('rejects empty', () => expect(isValidEmail('')).toBe(false));
  it('rejects spaces', () => expect(isValidEmail('a b@c.co')).toBe(false));
});
