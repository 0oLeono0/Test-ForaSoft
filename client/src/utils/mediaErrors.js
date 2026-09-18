// Ошибки доступа к камере и микрофону и коды клиентских состояний (TDD §4.1.4, §8.2).

/** Состояние дорожки после запроса устройства: `ok` или причина, по которой её нет. */
export const TRACK_STATUS = Object.freeze({
  OK: 'ok',
  DENIED: 'DENIED',
  NOT_FOUND: 'NOT_FOUND',
  BUSY: 'BUSY',
  ERROR: 'ERROR',
});

/** @typedef {typeof TRACK_STATUS[keyof typeof TRACK_STATUS]} TrackStatus */

/**
 * `DOMException.name` из `getUserMedia` → статус дорожки (TDD §4.1.4).
 * Неизвестное имя даёт `ERROR`: пользователь остаётся в комнате с выключенным устройством.
 */
const STATUS_BY_ERROR_NAME = Object.freeze({
  NotAllowedError: TRACK_STATUS.DENIED,
  SecurityError: TRACK_STATUS.DENIED,
  NotFoundError: TRACK_STATUS.NOT_FOUND,
  OverconstrainedError: TRACK_STATUS.NOT_FOUND,
  NotReadableError: TRACK_STATUS.BUSY,
  AbortError: TRACK_STATUS.BUSY,
});

/**
 * @param {unknown} error  исключение `getUserMedia`; обычно `DOMException`
 * @returns {TrackStatus}
 */
export function mapMediaError(error) {
  const name = typeof error === 'object' && error !== null ? error.name : undefined;
  return STATUS_BY_ERROR_NAME[name] ?? TRACK_STATUS.ERROR;
}

/**
 * Коды состояний, которые определяет сам клиент (TDD §8.2). Коды ответов сервера лежат
 * в `ERROR_CODES` из `@vcr/shared` и с этими не пересекаются.
 */
export const CLIENT_ERROR_CODES = Object.freeze({
  WEBRTC_UNSUPPORTED: 'WEBRTC_UNSUPPORTED',
  INSECURE_CONTEXT: 'INSECURE_CONTEXT',
  SERVER_UNAVAILABLE: 'SERVER_UNAVAILABLE',
  CONNECTION_LOST: 'CONNECTION_LOST',
  MEDIA_DENIED: 'MEDIA_DENIED',
  MEDIA_NOT_FOUND: 'MEDIA_NOT_FOUND',
  MEDIA_BUSY: 'MEDIA_BUSY',
  MEDIA_DEVICE_LOST: 'MEDIA_DEVICE_LOST',
  PEER_LINK_FAILED: 'PEER_LINK_FAILED',
  AUTOPLAY_BLOCKED: 'AUTOPLAY_BLOCKED',
  CLIPBOARD_FAILED: 'CLIPBOARD_FAILED',
});

/** @typedef {typeof CLIENT_ERROR_CODES[keyof typeof CLIENT_ERROR_CODES]} ClientErrorCode */

/**
 * Тексты уведомлений о недоступном устройстве (TDD §8.2). Формулировки разные для камеры и
 * микрофона: «устройство недоступно» не подсказывает, что именно чинить.
 */
const DEVICE_ERROR_MESSAGES = Object.freeze({
  [TRACK_STATUS.DENIED]: Object.freeze({
    audio: 'Нет доступа к микрофону. Разрешите доступ в настройках браузера',
    video: 'Нет доступа к камере. Разрешите доступ в настройках браузера',
  }),
  [TRACK_STATUS.NOT_FOUND]: Object.freeze({
    audio: 'Микрофон не найден',
    video: 'Камера не найдена',
  }),
  [TRACK_STATUS.BUSY]: Object.freeze({
    audio: 'Микрофон используется другим приложением',
    video: 'Камера используется другим приложением',
  }),
  [TRACK_STATUS.ERROR]: Object.freeze({
    audio: 'Не удалось включить микрофон',
    video: 'Не удалось включить камеру',
  }),
});

/**
 * Текст toast о недоступном устройстве (TDD §8.2).
 * @param {'audio'|'video'} kind
 * @param {TrackStatus|null} status
 * @returns {string|null}  `null` для `ok` и неизвестного статуса — сообщать нечего
 */
export function deviceErrorMessage(kind, status) {
  return DEVICE_ERROR_MESSAGES[status]?.[kind] ?? null;
}

/** Устройство пропало во время звонка (FR-20, TDD §8.2). */
export const DEVICE_LOST_MESSAGE = 'Устройство отключено';
