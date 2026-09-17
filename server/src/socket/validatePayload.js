// Проверка формы входящих payload Socket.io (TDD §4.2.1, §6.2, §6.3): типы, обязательные поля и
// длины данных сигналинга. Лишние поля отбрасываются. Содержимое roomId, имени и текста сообщения
// здесь не проверяется: это делают обработчики функциями из @vcr/shared со своими кодами ошибок.
import { ERROR_CODES } from '@vcr/shared';

/** @typedef {import('@vcr/shared').SignalData} SignalData */

/**
 * Значение, которое получает обработчик после проверки, для каждой схемы.
 * @typedef {Object} PayloadBySchema
 * @property {{ roomId: string, name: string }}     join
 * @property {{ text: string }}                     chat
 * @property {{ audio: boolean, video: boolean }}   media
 * @property {{ to: string, data: SignalData }}     signal
 */

/**
 * Длина SDP в UTF-16 code units. Обычный SDP занимает 5–10 КБ, кадр Socket.io — до 64 КБ
 * (TDD §10.4).
 */
export const SDP_MAX_LENGTH = 32 * 1024;

/** Длина строковых полей ICE-кандидата. Строка `candidate` обычно короче 300 символов. */
export const CANDIDATE_MAX_LENGTH = 1024;

/**
 * Длина `to`. id участника — UUID из 36 символов, а `to` возвращается отправителю
 * в `signal:error`.
 */
export const PEER_ID_MAX_LENGTH = 64;

/** `sdpMLineIndex` в `RTCIceCandidateInit` — unsigned short. */
const SDP_MLINE_INDEX_MAX = 65_535;

/** Объект из JSON: не массив, не `Buffer` из бинарного вложения Socket.io и не экземпляр класса. */
function isPlainObject(value) {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isStringOfLength(value, minLength, maxLength) {
  return typeof value === 'string' && value.length >= minLength && value.length <= maxLength;
}

function isNullableString(value) {
  return value === null || isStringOfLength(value, 0, CANDIDATE_MAX_LENGTH);
}

/** Поля `RTCIceCandidateInit`. Все необязательны; отсутствующие в результат не добавляются. */
const CANDIDATE_INIT_FIELDS = {
  candidate: (value) => isStringOfLength(value, 0, CANDIDATE_MAX_LENGTH),
  sdpMid: isNullableString,
  sdpMLineIndex: (value) =>
    value === null || (Number.isInteger(value) && value >= 0 && value <= SDP_MLINE_INDEX_MAX),
  usernameFragment: isNullableString,
};

/** @returns {RTCIceCandidateInit | null} */
function parseCandidateInit(init) {
  if (!isPlainObject(init)) return null;
  const value = {};
  for (const [field, isValid] of Object.entries(CANDIDATE_INIT_FIELDS)) {
    if (init[field] === undefined) continue;
    if (!isValid(init[field])) return null;
    value[field] = init[field];
  }
  return value;
}

/** @returns {SignalData | null} */
function parseSignalData(data) {
  if (!isPlainObject(data)) return null;
  switch (data.type) {
    case 'offer':
    case 'answer':
      return isStringOfLength(data.sdp, 1, SDP_MAX_LENGTH)
        ? { type: data.type, sdp: data.sdp }
        : null;
    case 'candidate': {
      // null — end-of-candidates: кандидатов больше не будет.
      if (data.candidate === null) return { type: 'candidate', candidate: null };
      const candidate = parseCandidateInit(data.candidate);
      return candidate && { type: 'candidate', candidate };
    }
    default:
      return null;
  }
}

/** Разбор каждой схемы: новый объект только с известными полями или `null`. */
const SCHEMAS = {
  // Содержимое проверяют isValidRoomId и validateName: INVALID_ROOM_ID, INVALID_NAME.
  join: ({ roomId, name }) =>
    typeof roomId === 'string' && typeof name === 'string' ? { roomId, name } : null,

  // Пустой и слишком длинный текст отклоняет validateMessage (MESSAGE_EMPTY, MESSAGE_TOO_LONG).
  chat: ({ text }) => (typeof text === 'string' ? { text } : null),

  media: ({ audio, video }) =>
    typeof audio === 'boolean' && typeof video === 'boolean' ? { audio, video } : null,

  // `from` из payload не берётся: его проставляет сервер (TDD §6.5, §10.1).
  signal: ({ to, data }) => {
    if (!isStringOfLength(to, 1, PEER_ID_MAX_LENGTH)) return null;
    const signalData = parseSignalData(data);
    return signalData && { to, data: signalData };
  },
};

/**
 * Проверяет форму payload события и возвращает копию только с известными полями.
 * @template {keyof PayloadBySchema} S
 * @param {S} schemaName
 * @param {unknown} payload  данные от клиента как есть
 * @returns {{ ok: true, value: PayloadBySchema[S] } | { ok: false, code: 'INVALID_PAYLOAD' }}
 */
export function validate(schemaName, payload) {
  if (!Object.hasOwn(SCHEMAS, schemaName)) {
    throw new Error(`Неизвестная схема payload: ${schemaName}`);
  }
  const value = isPlainObject(payload) ? SCHEMAS[schemaName](payload) : null;
  return value ? { ok: true, value } : { ok: false, code: ERROR_CODES.INVALID_PAYLOAD };
}
