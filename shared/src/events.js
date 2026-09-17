// Словарь Socket.io-событий и формы данных, которыми обмениваются клиент и сервер (TDD §6.2–6.4).

/** События клиент → сервер (TDD §6.3). */
export const CLIENT_EVENTS = Object.freeze({
  ROOM_JOIN: 'room:join',
  ROOM_LEAVE: 'room:leave',
  CHAT_SEND: 'chat:send',
  MEDIA_STATE: 'media:state',
  SIGNAL: 'signal',
});

/** События сервер → клиент (TDD §6.4). `signal` идёт в обе стороны: сервер пересылает его получателю. */
export const SERVER_EVENTS = Object.freeze({
  PARTICIPANT_JOINED: 'participant:joined',
  PARTICIPANT_LEFT: 'participant:left',
  PARTICIPANT_MEDIA: 'participant:media',
  CHAT_MESSAGE: 'chat:message',
  SIGNAL: 'signal',
  SIGNAL_ERROR: 'signal:error',
});

/**
 * Участник в том виде, в каком его видят другие клиенты (TDD §6.3). `socketId` наружу не отдаётся.
 * @typedef {Object} ParticipantDTO
 * @property {string}  id     // crypto.randomUUID(); в UI не показывается (FR-30)
 * @property {string}  name   // нормализованное, валидное имя (TDD §4.3)
 * @property {boolean} audio  // индикатор микрофона
 * @property {boolean} video  // индикатор камеры
 */

/**
 * Сообщение чата: пользовательское или системное (TDD §5.2, §5.3).
 * @typedef {Object} ChatMessage
 * @property {string} id                  // randomUUID
 * @property {'user'|'system'} type
 * @property {number} ts                  // epoch ms, часы сервера; клиент форматирует HH:MM (FR-22)
 * @property {string} [authorId]          // только для type='user'
 * @property {string} [authorName]        // только для type='user'; снимок имени на момент отправки
 * @property {string} [text]              // только для type='user'; нормализованный текст, НЕ HTML
 * @property {'joined'|'left'} [event]    // только для type='system'
 * @property {string} [subjectName]       // только для type='system'
 */

/**
 * Данные сигналинга WebRTC, которые сервер пересылает без изменений (TDD §6.3).
 * `candidate: null` означает end-of-candidates.
 * @typedef {{ type: 'offer', sdp: string }
 *   | { type: 'answer', sdp: string }
 *   | { type: 'candidate', candidate: RTCIceCandidateInit | null }} SignalData
 */

/**
 * Ошибка в ack (TDD §6.2, §8.1).
 * @typedef {Object} AckError
 * @property {import('./errors.js').ErrorCode} code
 * @property {string} message  // текст из ERROR_MESSAGES
 */

/**
 * Единый формат ack (TDD §6.2): `{ ok: true, ...data }` или `{ ok: false, error }`.
 * @template {object} [T={}]
 * @typedef {({ ok: true } & T) | { ok: false, error: AckError }} Ack
 */

/**
 * Данные успешного ack `room:join` (TDD §6.3, §6.5).
 * @typedef {Object} JoinAckData
 * @property {ParticipantDTO}   self
 * @property {ParticipantDTO[]} participants  // другие участники в порядке входа — список пиров для offer
 * @property {ChatMessage[]}    messages      // история комнаты без собственного `joined`
 * @property {RTCIceServer[]}   iceServers
 * @property {{ messageMaxLength: number }} limits
 */

/**
 * Данные успешного ack `chat:send` (TDD §6.3).
 * @typedef {Object} ChatSendAckData
 * @property {ChatMessage} message
 */

/** @typedef {Ack<JoinAckData>} JoinAck */
/** @typedef {Ack} LeaveAck */
/** @typedef {Ack<ChatSendAckData>} ChatSendAck */
