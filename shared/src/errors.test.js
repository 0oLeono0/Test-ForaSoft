import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_MESSAGES } from './errors.js';

// Таблица TDD §8.1 в порядке строк.
const DESIGN_CODES = [
  'INVALID_PAYLOAD',
  'INVALID_ROOM_ID',
  'INVALID_NAME',
  'ROOM_FULL',
  'ALREADY_IN_ROOM',
  'NOT_IN_ROOM',
  'MESSAGE_EMPTY',
  'MESSAGE_TOO_LONG',
  'RATE_LIMITED',
  'PEER_NOT_FOUND',
  'INVALID_SIGNAL',
  'INTERNAL_ERROR',
];

describe('ERROR_CODES', () => {
  it('содержит ровно 12 кодов из TDD §8.1', () => {
    expect(Object.keys(ERROR_CODES)).toEqual(DESIGN_CODES);
  });

  it('значение каждого кода совпадает с ключом', () => {
    for (const [key, value] of Object.entries(ERROR_CODES)) {
      expect(value).toBe(key);
    }
  });

  it('заморожен', () => {
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
  });
});

describe('ERROR_MESSAGES', () => {
  it('содержит непустой текст для каждого кода и не содержит лишних', () => {
    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual([...DESIGN_CODES].sort());
    for (const code of Object.values(ERROR_CODES)) {
      expect(ERROR_MESSAGES[code], code).toEqual(expect.any(String));
      expect(ERROR_MESSAGES[code].trim(), code).not.toBe('');
    }
  });

  it('совпадает с текстами для UI из TDD §8.1', () => {
    expect(ERROR_MESSAGES).toMatchObject({
      INVALID_PAYLOAD: 'Некорректный запрос',
      INVALID_ROOM_ID: 'Некорректная ссылка на комнату',
      INVALID_NAME: 'Имя может содержать буквы, цифры, пробел, «-», «_», «.» (до 30 символов)',
      ROOM_FULL: 'Комната заполнена',
      MESSAGE_TOO_LONG: 'Сообщение длиннее 1000 символов',
      RATE_LIMITED: 'Слишком часто, подождите немного',
      INTERNAL_ERROR: 'Внутренняя ошибка сервера',
    });
  });

  it('заморожен', () => {
    expect(Object.isFrozen(ERROR_MESSAGES)).toBe(true);
  });
});
