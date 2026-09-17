import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RATE_LIMITS, RateLimiter } from './rateLimiter.js';

const START = 1789640000000;
const BUCKETS = Object.entries(RATE_LIMITS);

/** Сколько из `attempts` попыток подряд пропущено. */
function countAllowed(limiter, key, bucket, attempts) {
  let allowed = 0;
  for (let i = 0; i < attempts; i += 1) {
    if (limiter.consume(key, bucket)) allowed += 1;
  }
  return allowed;
}

function exhaust(limiter, key, bucket) {
  countAllowed(limiter, key, bucket, RATE_LIMITS[bucket].capacity);
  expect(limiter.consume(key, bucket), `${bucket} исчерпан`).toBe(false);
}

beforeEach(() => {
  vi.useFakeTimers({ now: START });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RATE_LIMITS', () => {
  it('совпадает с таблицей TDD §10.4', () => {
    expect(RATE_LIMITS).toEqual({
      join: { capacity: 5, windowMs: 10_000 },
      chat: { capacity: 5, windowMs: 5_000 },
      media: { capacity: 20, windowMs: 10_000 },
      signal: { capacity: 300, windowMs: 10_000 },
    });
  });

  it('заморожен вместе с лимитами bucket-ов', () => {
    expect(Object.isFrozen(RATE_LIMITS)).toBe(true);
    for (const [bucket, limit] of BUCKETS) {
      expect(Object.isFrozen(limit), bucket).toBe(true);
    }
  });
});

describe('RateLimiter: burst', () => {
  it.each(BUCKETS)(
    '%s: пропускает capacity событий подряд и отклоняет следующее',
    (bucket, limit) => {
      const limiter = new RateLimiter();

      expect(countAllowed(limiter, 's1', bucket, limit.capacity)).toBe(limit.capacity);
      expect(limiter.consume('s1', bucket)).toBe(false);
      expect(limiter.consume('s1', bucket)).toBe(false);
    },
  );
});

describe('RateLimiter: пополнение', () => {
  it('chat: токен возвращается ровно через 1 с (5 за 5 с), не раньше', () => {
    const limiter = new RateLimiter();
    exhaust(limiter, 's1', 'chat');

    vi.advanceTimersByTime(999);
    expect(limiter.consume('s1', 'chat')).toBe(false);

    vi.advanceTimersByTime(1);
    expect(limiter.consume('s1', 'chat')).toBe(true);
    expect(limiter.consume('s1', 'chat')).toBe(false);
  });

  it.each(BUCKETS)('%s: за windowMs запас восстанавливается полностью', (bucket, limit) => {
    const limiter = new RateLimiter();
    exhaust(limiter, 's1', bucket);

    vi.advanceTimersByTime(limit.windowMs);

    expect(countAllowed(limiter, 's1', bucket, limit.capacity + 1)).toBe(limit.capacity);
  });

  it('запас не превышает capacity после долгого простоя', () => {
    const limiter = new RateLimiter();
    limiter.consume('s1', 'chat');

    vi.advanceTimersByTime(60 * 60 * 1000);

    expect(countAllowed(limiter, 's1', 'chat', 10)).toBe(5);
  });

  it('пополнение копится по частям, отклонённые попытки его не сбрасывают', () => {
    const limiter = new RateLimiter();
    exhaust(limiter, 's1', 'chat');

    for (let step = 1; step <= 4; step += 1) {
      vi.advanceTimersByTime(200);
      expect(limiter.consume('s1', 'chat'), `${step * 200} мс`).toBe(false);
    }
    vi.advanceTimersByTime(200);
    expect(limiter.consume('s1', 'chat')).toBe(true);
  });

  it('частые попытки получают токен вовремя: пополнение без ошибок округления', () => {
    const limiter = new RateLimiter();
    exhaust(limiter, 's1', 'chat');

    // С дробными токенами 10 шагов по 0.1 дали бы 0.9999999999999999 < 1, и каждый токен
    // приходил бы на 100 мс позже.
    const allowedAt = [];
    for (let ms = 100; ms <= 5_000; ms += 100) {
      vi.advanceTimersByTime(100);
      if (limiter.consume('s1', 'chat')) allowedAt.push(ms);
    }
    expect(allowedAt).toEqual([1_000, 2_000, 3_000, 4_000, 5_000]);
  });

  it('равномерный поток в пределах лимита не отклоняется', () => {
    const limiter = new RateLimiter();

    for (let i = 0; i < 50; i += 1) {
      expect(limiter.consume('s1', 'join'), `попытка ${i + 1}`).toBe(true);
      vi.advanceTimersByTime(2_000);
    }
  });

  it('перевод часов назад не отнимает запас', () => {
    const limiter = new RateLimiter();
    countAllowed(limiter, 's1', 'chat', 2);

    vi.setSystemTime(START - 60_000);
    expect(countAllowed(limiter, 's1', 'chat', 5)).toBe(3);

    vi.advanceTimersByTime(1_000);
    expect(countAllowed(limiter, 's1', 'chat', 5)).toBe(1);
  });
});

describe('RateLimiter: изоляция', () => {
  it('ключи (сокеты) не влияют друг на друга', () => {
    const limiter = new RateLimiter();
    exhaust(limiter, 's1', 'chat');

    expect(countAllowed(limiter, 's2', 'chat', 6)).toBe(5);
    expect(limiter.consume('s1', 'chat')).toBe(false);
  });

  it('bucket-ы одного ключа не влияют друг на друга', () => {
    const limiter = new RateLimiter();
    exhaust(limiter, 's1', 'chat');

    for (const [bucket, limit] of BUCKETS.filter(([name]) => name !== 'chat')) {
      expect(countAllowed(limiter, 's1', bucket, limit.capacity), bucket).toBe(limit.capacity);
    }
    expect(limiter.consume('s1', 'chat')).toBe(false);
  });

  it('экземпляры не делят состояние', () => {
    const first = new RateLimiter();
    exhaust(first, 's1', 'chat');

    expect(new RateLimiter().consume('s1', 'chat')).toBe(true);
  });
});

describe('RateLimiter: forget', () => {
  it('сбрасывает все bucket-ы ключа', () => {
    const limiter = new RateLimiter();
    exhaust(limiter, 's1', 'chat');
    exhaust(limiter, 's1', 'join');

    limiter.forget('s1');

    expect(countAllowed(limiter, 's1', 'chat', 6)).toBe(5);
    expect(countAllowed(limiter, 's1', 'join', 6)).toBe(5);
  });

  it('не затрагивает другие ключи', () => {
    const limiter = new RateLimiter();
    exhaust(limiter, 's1', 'chat');
    exhaust(limiter, 's2', 'chat');

    limiter.forget('s1');

    expect(limiter.consume('s2', 'chat')).toBe(false);
  });

  it('для неизвестного ключа ничего не делает', () => {
    const limiter = new RateLimiter();

    expect(() => limiter.forget('unknown')).not.toThrow();
    expect(limiter.consume('unknown', 'chat')).toBe(true);
  });
});

describe('RateLimiter: конфигурация', () => {
  it.each(['unknown', 'toString', '__proto__', ''])('неизвестный bucket %j — ошибка', (bucket) => {
    expect(() => new RateLimiter().consume('s1', bucket)).toThrow('Неизвестный bucket');
  });

  it('принимает собственные лимиты', () => {
    const limiter = new RateLimiter({ burst: { capacity: 2, windowMs: 100 } });

    expect(countAllowed(limiter, 's1', 'burst', 3)).toBe(2);
    vi.advanceTimersByTime(50);
    expect(countAllowed(limiter, 's1', 'burst', 3)).toBe(1);
    expect(() => limiter.consume('s1', 'chat')).toThrow('Неизвестный bucket');
  });
});
