import { describe, expect, it } from 'vitest';

describe('shared: тестовый раннер', () => {
  it('выполняется в окружении node без DOM', () => {
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
  });
});
