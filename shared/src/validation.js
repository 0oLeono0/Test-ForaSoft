// Нормализация и валидация пользовательского ввода. Одни и те же правила на клиенте и сервере (TDD §4.3).
import { NAME_ALLOWED_CHARS, NAME_HAS_ALNUM, NAME_MAX_LENGTH } from './constants.js';

/**
 * Причины, по которым имя не прошло `validateName`. Сервер отвечает на любую из них кодом
 * `INVALID_NAME` (TDD §8.1), клиент показывает подсказку под полем.
 */
export const NAME_ERROR_CODES = Object.freeze({
  NAME_EMPTY: 'NAME_EMPTY',
  NAME_TOO_LONG: 'NAME_TOO_LONG',
  NAME_INVALID_CHARS: 'NAME_INVALID_CHARS',
});

/** @typedef {keyof typeof NAME_ERROR_CODES} NameErrorCode */

/**
 * @template {string} C
 * @typedef {{ ok: true, value: string } | { ok: false, code: C }} ValidationResult
 */

/** Длина строки в code points: суррогатная пара (например, `𝐀`) считается одним символом. */
function codePointLength(value) {
  return [...value].length;
}

/**
 * NFC, обрезка пробельных символов по краям и замена любой их последовательности внутри
 * на один обычный пробел. Не проверяет допустимость символов — это делает `validateName`.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeName(raw) {
  return raw.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

/**
 * Проверяет имя после нормализации: 1–30 code points, только буквы, цифры, пробел, `.`, `_`, `-`,
 * хотя бы одна буква или цифра. Невалидное имя отклоняется, а не исправляется.
 * @param {unknown} raw  значение любого типа; не-строка считается отсутствующим именем
 * @returns {ValidationResult<NameErrorCode>}  при успехе `value` — нормализованное имя
 */
export function validateName(raw) {
  if (typeof raw !== 'string') return { ok: false, code: NAME_ERROR_CODES.NAME_EMPTY };

  const value = normalizeName(raw);
  if (value === '') return { ok: false, code: NAME_ERROR_CODES.NAME_EMPTY };
  if (codePointLength(value) > NAME_MAX_LENGTH) {
    return { ok: false, code: NAME_ERROR_CODES.NAME_TOO_LONG };
  }
  if (!NAME_ALLOWED_CHARS.test(value) || !NAME_HAS_ALNUM.test(value)) {
    return { ok: false, code: NAME_ERROR_CODES.NAME_INVALID_CHARS };
  }
  return { ok: true, value };
}
