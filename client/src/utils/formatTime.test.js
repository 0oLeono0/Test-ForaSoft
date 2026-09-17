import { describe, expect, it } from 'vitest';
import { formatTime } from './formatTime.js';

// Часовой пояс тестов задан в vitest.config.js: TZ=Europe/Moscow (UTC+3, без перехода на летнее
// время). Так видно, что время переводится в локальную зону клиента, а не остаётся UTC (FR-22).
describe('formatTime', () => {
  it.each([
    ['2026-09-17T06:05:09.000Z', '09:05'],
    ['2026-09-17T21:00:00.000Z', '00:00'],
    ['2026-01-01T20:59:59.999Z', '23:59'],
    ['2026-09-17T09:30:00.000Z', '12:30'],
  ])('%s → %s по местному времени', (iso, expected) => {
    expect(formatTime(Date.parse(iso))).toBe(expected);
  });

  it('часы всегда двузначные и без AM/PM', () => {
    expect(formatTime(Date.parse('2026-09-17T00:07:00.000Z'))).toBe('03:07');
  });

  it.each([undefined, null, NaN, Infinity, '1789640000000'])(
    'без корректного времени (%s) возвращает пустую строку',
    (ts) => {
      expect(formatTime(ts)).toBe('');
    },
  );
});
