// Token bucket на сокет и тип события: защита от флуда join/chat/media/signal (FR-40, TDD §10.4).

/**
 * Не больше `capacity` событий подряд; запас пополняется равномерно, `capacity` токенов за `windowMs`.
 * @typedef {{ capacity: number, windowMs: number }} BucketLimit
 */

/**
 * Лимиты из TDD §10.4. Что делать при превышении (ack `RATE_LIMITED`, `signal:error` или молча
 * игнорировать), решает обработчик.
 * @type {Readonly<Record<'join' | 'chat' | 'media' | 'signal', Readonly<BucketLimit>>>}
 */
export const RATE_LIMITS = Object.freeze({
  join: Object.freeze({ capacity: 5, windowMs: 10_000 }),
  chat: Object.freeze({ capacity: 5, windowMs: 5_000 }),
  media: Object.freeze({ capacity: 20, windowMs: 10_000 }),
  // Хватает на всплеск ICE-кандидатов при согласовании с тремя пирами.
  signal: Object.freeze({ capacity: 300, windowMs: 10_000 }),
});

export class RateLimiter {
  /**
   * Ключ → bucket → состояние. Запас хранится в целых «токено-миллисекундах»: один токен равен
   * `windowMs`, а каждая прошедшая миллисекунда добавляет `capacity`. Так пополнение считается
   * точно, без накопления ошибок округления float.
   * @type {Map<string, Map<string, { credit: number, updatedAt: number }>>}
   */
  #buckets = new Map();
  #limits;

  /** @param {Record<string, BucketLimit>} [limits] */
  constructor(limits = RATE_LIMITS) {
    this.#limits = limits;
  }

  /**
   * Списывает один токен. Bucket создаётся полным при первом обращении.
   * @param {string} key  `socket.id`
   * @param {string} bucketName  имя из `RATE_LIMITS`
   * @returns {boolean}  `false`, если запас исчерпан и событие нужно отклонить
   */
  consume(key, bucketName) {
    if (!Object.hasOwn(this.#limits, bucketName)) {
      throw new Error(`Неизвестный bucket rate limit: ${bucketName}`);
    }
    const { capacity, windowMs } = this.#limits[bucketName];
    const full = capacity * windowMs;
    const now = Date.now();

    let buckets = this.#buckets.get(key);
    if (!buckets) {
      buckets = new Map();
      this.#buckets.set(key, buckets);
    }
    const state = buckets.get(bucketName) ?? { credit: full, updatedAt: now };
    buckets.set(bucketName, state);

    // Если системные часы перевели назад, интервал отрицательный: запас не уменьшается.
    const elapsed = Math.max(0, now - state.updatedAt);
    state.credit = Math.min(full, state.credit + elapsed * capacity);
    state.updatedAt = now;

    if (state.credit < windowMs) return false;
    state.credit -= windowMs;
    return true;
  }

  /**
   * Удаляет все bucket'ы ключа. Вызывается при отключении сокета, чтобы память не росла.
   * @param {string} key  `socket.id`
   */
  forget(key) {
    this.#buckets.delete(key);
  }
}
