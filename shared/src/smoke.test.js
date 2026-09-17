import { describe, expect, it } from 'vitest';
import { MAX_PARTICIPANTS } from './index.js';

describe('shared: тестовый раннер', () => {
  it('выполняется в окружении node без DOM', () => {
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
  });

  it('экспортирует лимит участников', () => {
    expect(MAX_PARTICIPANTS).toBe(4);
  });
});
