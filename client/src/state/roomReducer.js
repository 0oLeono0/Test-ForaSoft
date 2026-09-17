// Состояние экрана комнаты (TDD §4.1.6). Чистая функция: сеть, WebRTC и таймеры — в сервисах.
import { CHAT_HISTORY_LIMIT, ERROR_CODES } from '@vcr/shared';
import { CLIENT_ERROR_CODES } from '../utils/mediaErrors.js';

/** Фазы конечного автомата `RoomPage` (TDD §4.1.2). */
export const PHASES = Object.freeze({
  NAME_FORM: 'nameForm',
  CHECKING_ENV: 'checkingEnv',
  CONNECTING: 'connecting',
  JOINING: 'joining',
  IN_ROOM: 'inRoom',
  ROOM_FULL: 'roomFull',
  SERVER_UNAVAILABLE: 'serverUnavailable',
  INSECURE_CONTEXT: 'insecureContext',
  UNSUPPORTED: 'unsupported',
  CONNECTION_LOST: 'connectionLost',
  JOIN_ERROR: 'joinError',
  LEFT: 'left',
});

/** Действия reducer (TDD §4.1.6): компоненты и сервисы используют эти константы, не литералы. */
export const ACTIONS = Object.freeze({
  PHASE: 'PHASE',
  JOIN_OK: 'JOIN_OK',
  JOIN_FAILED: 'JOIN_FAILED',
  PARTICIPANT_JOINED: 'PARTICIPANT_JOINED',
  PARTICIPANT_LEFT: 'PARTICIPANT_LEFT',
  PARTICIPANT_MEDIA: 'PARTICIPANT_MEDIA',
  CHAT_MESSAGE: 'CHAT_MESSAGE',
  LOCAL_MEDIA: 'LOCAL_MEDIA',
  LINK_STATUS: 'LINK_STATUS',
  AUDIO_LOCKED: 'AUDIO_LOCKED',
  CONNECTION_LOST: 'CONNECTION_LOST',
  LEFT: 'LEFT',
});

/** Состояние P2P-соединения с одним участником (TDD §4.1.6). */
export const LINK_STATUS = Object.freeze({
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  FAILED: 'failed',
  CLOSED: 'closed',
});

/** @typedef {{ id: string, name: string, audio: boolean, video: boolean }} ParticipantView */
/** @typedef {typeof LINK_STATUS[keyof typeof LINK_STATUS]} LinkStatusValue */
/** @typedef {import('@vcr/shared').ChatMessage} ChatMessage */

/**
 * @typedef {Object} RoomState
 * @property {string}  phase        // одна из PHASES
 * @property {string|null} error    // код из §8.1 или §8.2, если фаза — экран ошибки
 * @property {string|null} roomId
 * @property {string|null} selfId
 * @property {ParticipantView[]} participants  // порядок входа, себя включая (FR-26)
 * @property {ChatMessage[]} messages          // не больше CHAT_HISTORY_LIMIT
 * @property {{ audio: boolean, video: boolean, audioStatus: string|null, videoStatus: string|null }} local
 * @property {Record<string, LinkStatusValue>} links
 * @property {boolean} audioLocked  // autoplay заблокирован (FR-37)
 */

/** @type {Readonly<RoomState>} */
export const initialState = Object.freeze({
  phase: PHASES.NAME_FORM,
  error: null,
  roomId: null,
  selfId: null,
  participants: [],
  messages: [],
  local: Object.freeze({ audio: false, video: false, audioStatus: null, videoStatus: null }),
  links: Object.freeze({}),
  audioLocked: false,
});

/** Данные комнаты, которые теряют смысл после выхода и обрыва: `roomId` остаётся для «Войти заново». */
const EMPTY_ROOM = Object.freeze({
  selfId: initialState.selfId,
  participants: initialState.participants,
  messages: initialState.messages,
  local: initialState.local,
  links: initialState.links,
  audioLocked: initialState.audioLocked,
});

/**
 * Код ошибки входа → фаза (TDD §4.1.2, §8.1, §8.2). Коды, которых здесь нет
 * (`INVALID_ROOM_ID`, `INVALID_PAYLOAD`, `INTERNAL_ERROR`, …), ведут на экран `JOIN_ERROR`
 * с кнопкой «На главную».
 */
const PHASE_BY_JOIN_ERROR = Object.freeze({
  [ERROR_CODES.ROOM_FULL]: PHASES.ROOM_FULL,
  [ERROR_CODES.INVALID_NAME]: PHASES.NAME_FORM,
  [CLIENT_ERROR_CODES.SERVER_UNAVAILABLE]: PHASES.SERVER_UNAVAILABLE,
  [CLIENT_ERROR_CODES.INSECURE_CONTEXT]: PHASES.INSECURE_CONTEXT,
  [CLIENT_ERROR_CODES.WEBRTC_UNSUPPORTED]: PHASES.UNSUPPORTED,
});

/** Лишние поля `ParticipantDTO` в состояние не попадают. @returns {ParticipantView} */
function toParticipantView({ id, name, audio, video }) {
  return { id, name, audio, video };
}

/** История клиента ограничена так же, как серверная (FR-23): лишние старые сообщения выпадают. */
function limitHistory(messages) {
  return messages.length > CHAT_HISTORY_LIMIT ? messages.slice(-CHAT_HISTORY_LIMIT) : messages;
}

/**
 * @param {RoomState} state
 * @param {{ type: string } & Record<string, unknown>} action
 * @returns {RoomState}
 */
export function roomReducer(state, action) {
  switch (action.type) {
    // Переходы NameForm → CheckingEnv → Connecting → Joining (TDD §4.1.2).
    case ACTIONS.PHASE:
      return { ...state, phase: action.phase, error: action.error ?? null };

    case ACTIONS.JOIN_OK: {
      // В ack участники идут в порядке входа и без себя: сам вошедший — последний (TDD §6.3).
      const participants = [...action.participants, action.self].map(toParticipantView);
      return {
        ...state,
        phase: PHASES.IN_ROOM,
        error: null,
        roomId: action.roomId,
        selfId: action.self.id,
        participants,
        messages: limitHistory(action.messages),
      };
    }

    case ACTIONS.JOIN_FAILED:
      return {
        ...state,
        phase: PHASE_BY_JOIN_ERROR[action.error] ?? PHASES.JOIN_ERROR,
        error: action.error,
      };

    case ACTIONS.PARTICIPANT_JOINED: {
      // Своё `participant:joined` сервер не присылает, но повтор не должен удваивать список.
      if (state.participants.some(({ id }) => id === action.participant.id)) return state;
      return {
        ...state,
        participants: [...state.participants, toParticipantView(action.participant)],
      };
    }

    case ACTIONS.PARTICIPANT_LEFT: {
      const participants = state.participants.filter(({ id }) => id !== action.participantId);
      const hasLink = Object.hasOwn(state.links, action.participantId);
      if (participants.length === state.participants.length && !hasLink) return state;
      // Вместе с участником уходит и статус соединения с ним: плитка исчезает целиком (FR-27).
      const links = { ...state.links };
      delete links[action.participantId];
      return { ...state, participants, links };
    }

    case ACTIONS.PARTICIPANT_MEDIA: {
      const index = state.participants.findIndex(({ id }) => id === action.participantId);
      if (index === -1) return state;
      const participants = [...state.participants];
      participants[index] = {
        ...participants[index],
        audio: action.audio,
        video: action.video,
      };
      return { ...state, participants };
    }

    case ACTIONS.CHAT_MESSAGE: {
      // Своё сообщение приходит и в ack, и в broadcast — дедупликация по id (TDD §6.4).
      if (state.messages.some(({ id }) => id === action.message.id)) return state;
      return { ...state, messages: limitHistory([...state.messages, action.message]) };
    }

    case ACTIONS.LOCAL_MEDIA:
      return { ...state, local: { ...state.local, ...action.local } };

    case ACTIONS.LINK_STATUS:
      return { ...state, links: { ...state.links, [action.peerId]: action.status } };

    case ACTIONS.AUDIO_LOCKED:
      return { ...state, audioLocked: action.locked };

    // Обрыв и выход: комната закрыта, mesh и треки освобождают сервисы (TDD §7.6).
    case ACTIONS.CONNECTION_LOST:
      return {
        ...state,
        ...EMPTY_ROOM,
        phase: PHASES.CONNECTION_LOST,
        error: CLIENT_ERROR_CODES.CONNECTION_LOST,
      };

    case ACTIONS.LEFT:
      return { ...state, ...EMPTY_ROOM, phase: PHASES.LEFT, error: null };

    default:
      throw new Error(`Неизвестное действие roomReducer: ${String(action.type)}`);
  }
}
