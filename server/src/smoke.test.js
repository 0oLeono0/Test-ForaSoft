import { describe, expect, it } from 'vitest';

describe('server: тестовый раннер', () => {
  it('выполняется в Node.js не ниже 20 (engines)', () => {
    const major = Number(process.versions.node.split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(20);
    expect(typeof document).toBe('undefined');
  });
});
