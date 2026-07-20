const RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(s: string): boolean {
  return typeof s === 'string' && RE.test(s.trim());
}
export function normalizeEmail(s: string): string {
  return s.trim().toLowerCase();
}
