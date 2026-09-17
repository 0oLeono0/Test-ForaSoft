import { MESSAGE_MAX_LENGTH, NAME_MAX_LENGTH } from './constants.js';

/**
 * Коды ошибок сервера для ack и `signal:error` (TDD §8.1).
 * Ключ совпадает со значением: сравнивайте с `ERROR_CODES.X`, а не со строковым литералом.
 */
export const ERROR_CODES = Object.freeze({
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  INVALID_ROOM_ID: 'INVALID_ROOM_ID',
  INVALID_NAME: 'INVALID_NAME',
  ROOM_FULL: 'ROOM_FULL',
  ALREADY_IN_ROOM: 'ALREADY_IN_ROOM',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  MESSAGE_EMPTY: 'MESSAGE_EMPTY',
  MESSAGE_TOO_LONG: 'MESSAGE_TOO_LONG',
  RATE_LIMITED: 'RATE_LIMITED',
  PEER_NOT_FOUND: 'PEER_NOT_FOUND',
  INVALID_SIGNAL: 'INVALID_SIGNAL',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

/** @typedef {keyof typeof ERROR_CODES} ErrorCode */

/**
 * Тексты для `error.message` в ack (TDD §6.2).
 * Коды, для которых в §8.1 нет текста для UI, клиент не показывает (игнорирует или пишет в лог);
 * их тексты нужны только для единого формата ack и отладки.
 * @type {Readonly<Record<ErrorCode, string>>}
 */
export const ERROR_MESSAGES = Object.freeze({
  INVALID_PAYLOAD: 'Некорректный запрос',
  INVALID_ROOM_ID: 'Некорректная ссылка на комнату',
  INVALID_NAME: `Имя может содержать буквы, цифры, пробел, «-», «_», «.» (до ${NAME_MAX_LENGTH} символов)`,
  ROOM_FULL: 'Комната заполнена',
  ALREADY_IN_ROOM: 'Вы уже находитесь в комнате',
  NOT_IN_ROOM: 'Вы не находитесь в комнате',
  MESSAGE_EMPTY: 'Сообщение не может быть пустым',
  MESSAGE_TOO_LONG: `Сообщение длиннее ${MESSAGE_MAX_LENGTH} символов`,
  RATE_LIMITED: 'Слишком часто, подождите немного',
  PEER_NOT_FOUND: 'Участник не найден в комнате',
  INVALID_SIGNAL: 'Некорректные данные сигналинга',
  INTERNAL_ERROR: 'Внутренняя ошибка сервера',
});
