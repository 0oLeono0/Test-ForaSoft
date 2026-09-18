// Оркестратор одной сессии комнаты (TDD §4.1.3): ведёт конечный автомат входа, переводит
// события сервера в действия reducer и владеет подписками.
//
// Часть 1 — всё, что не требует WebRTC: вход, чат, список участников, выход и обрыв связи
// (TDD §4.1.2, §6.3, §6.4, §7.6). Медиа и mesh подключаются в задаче 8.5.
import {
  ERROR_CODES,
  ERROR_MESSAGES,
  MESSAGE_MAX_LENGTH,
  SERVER_EVENTS,
  isValidRoomId,
} from '@vcr/shared';
import { ACTIONS, PHASES } from '../state/roomReducer.js';
import { show as showToast } from '../state/toasts.js';
import { CLIENT_ERROR_CODES } from '../utils/mediaErrors.js';
import { SIGNALING_EVENTS, createSignalingClient } from './SignalingClient.js';
import { checkSupport as defaultCheckSupport } from './environment.js';

/**
 * Ошибки `chat:send`, о которых пользователю сообщать нечего (TDD §8.1): пустое сообщение
 * кнопка «Отправить» и так не пропускает, а `NOT_IN_ROOM` приходит уже после выхода.
 */
const SILENT_CHAT_ERRORS = new Set([ERROR_CODES.MESSAGE_EMPTY, ERROR_CODES.NOT_IN_ROOM]);

/** Запасной текст: код есть, а текста для UI в §8.1 нет (например, таймаут ack). */
const CHAT_FALLBACK_MESSAGE = 'Сообщение не отправлено. Попробуйте ещё раз';

export class RoomSession {
  #dispatch;
  #signaling;
  #checkSupport;
  /** @type {(() => void)[]} отписки от событий сервера; снимаются в `destroy` и при обрыве */
  #unsubscribes = [];
  /** Вход уже идёт или завершился успехом: защита от двойного клика (TDD §8.3). */
  #started = false;
  #inRoom = false;
  #destroyed = false;
  #limits = { messageMaxLength: MESSAGE_MAX_LENGTH };
  /** @type {RTCIceServer[]} из ack `room:join`; понадобится `PeerLink` (TDD §4.1.4). */
  #iceServers = [];
  #selfId = null;

  /**
   * @param {Object} deps
   * @param {(action: object) => void} deps.dispatch  `dispatch` из `useReducer(roomReducer)`
   * @param {object} [deps.signaling]  `SignalingClient`; в тестах — мок
   * @param {() => { ok: boolean, reason?: string }} [deps.checkSupport]
   */
  constructor({ dispatch, signaling, checkSupport = defaultCheckSupport }) {
    this.#dispatch = dispatch;
    this.#signaling = signaling ?? createSignalingClient();
    this.#checkSupport = checkSupport;
  }

  /** Пределы из ack `room:join`: длина сообщения может отличаться от константы клиента (§6.3). */
  get limits() {
    return this.#limits;
  }

  /** @returns {RTCIceServer[]} */
  get iceServers() {
    return this.#iceServers;
  }

  /** @returns {string|null} */
  get selfId() {
    return this.#selfId;
  }

  /**
   * Вход в комнату: проверка окружения → подключение → `room:join` (TDD §4.1.2).
   * Повторный вызов во время входа игнорируется; после экрана ошибки («Повторить вход»,
   * «Войти заново») вызывать можно снова.
   * @param {{ roomId: string, name: string }} params
   * @returns {Promise<void>}
   */
  async start({ roomId, name }) {
    if (this.#started || this.#destroyed) return;
    this.#started = true;

    this.#dispatch({ type: ACTIONS.PHASE, phase: PHASES.CHECKING_ENV });
    const support = this.#checkSupport();
    if (!support.ok) return this.#fail(support.reason);
    // Ссылку с мусором вместо roomId незачем нести на сервер — ответ известен заранее (TDD §8.3).
    if (!isValidRoomId(roomId)) return this.#fail(ERROR_CODES.INVALID_ROOM_ID);

    this.#dispatch({ type: ACTIONS.PHASE, phase: PHASES.CONNECTING });
    try {
      await this.#signaling.connect();
    } catch (error) {
      return this.#fail(error?.code ?? CLIENT_ERROR_CODES.SERVER_UNAVAILABLE);
    }
    if (this.#destroyed) return;

    // Подписки — до `join`: событие о следующем участнике может прийти сразу за ack.
    this.#subscribe();

    this.#dispatch({ type: ACTIONS.PHASE, phase: PHASES.JOINING });
    let ack;
    try {
      ack = await this.#signaling.join(roomId, name);
    } catch (error) {
      // `ALREADY_IN_ROOM` — эхо второго `room:join`: вход уже состоялся, экран менять не нужно.
      if (error?.code === ERROR_CODES.ALREADY_IN_ROOM) return;
      return this.#fail(error?.code ?? ERROR_CODES.INTERNAL_ERROR);
    }
    if (this.#destroyed) return;

    this.#limits = ack.limits ?? this.#limits;
    this.#iceServers = ack.iceServers ?? [];
    this.#selfId = ack.self.id;
    this.#inRoom = true;
    this.#dispatch({
      type: ACTIONS.JOIN_OK,
      roomId,
      self: ack.self,
      participants: ack.participants,
      messages: ack.messages,
    });
  }

  /**
   * Отправка сообщения. Своё сообщение приходит броадкастом и отрисовывается оттуда, поэтому
   * ack нужен только для подтверждения и ошибок (TDD §6.4).
   * @param {string} text
   * @returns {Promise<boolean>}  `false` — текст остаётся в поле ввода (TDD §8.1)
   */
  async sendMessage(text) {
    try {
      await this.#signaling.sendChat(text);
      return true;
    } catch (error) {
      const code = error?.code;
      if (!SILENT_CHAT_ERRORS.has(code)) {
        showToast(ERROR_MESSAGES[code] ?? CHAT_FALLBACK_MESSAGE);
      }
      return false;
    }
  }

  /**
   * Выход по кнопке (TDD §7.6): дожидаемся ack, чтобы сервер успел разослать `participant:left`,
   * затем закрываем сокет. Ошибка ack ничего не меняет — `disconnect` освободит слот в любом случае.
   * @returns {Promise<void>}
   */
  async leave() {
    if (this.#destroyed) return;
    this.#inRoom = false;
    try {
      await this.#signaling.leave();
    } catch {
      // Сокет всё равно закрывается: сервер освободит слот в обработчике `disconnect`.
    }
    if (this.#destroyed) return;
    this.#cleanup();
    this.#signaling.disconnect();
    this.#started = false;
    this.#dispatch({ type: ACTIONS.LEFT });
  }

  /** Размонтирование `RoomPage`: снять подписки и закрыть сокет, состояние уже не нужно. */
  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#cleanup();
    this.#signaling.disconnect();
  }

  #subscribe() {
    if (this.#unsubscribes.length > 0) return;
    const on = (event, handler) => this.#unsubscribes.push(this.#signaling.on(event, handler));

    on(SERVER_EVENTS.PARTICIPANT_JOINED, ({ participant }) => {
      this.#dispatch({ type: ACTIONS.PARTICIPANT_JOINED, participant });
    });
    on(SERVER_EVENTS.PARTICIPANT_LEFT, ({ participantId }) => {
      this.#dispatch({ type: ACTIONS.PARTICIPANT_LEFT, participantId });
    });
    on(SERVER_EVENTS.PARTICIPANT_MEDIA, ({ participantId, audio, video }) => {
      this.#dispatch({ type: ACTIONS.PARTICIPANT_MEDIA, participantId, audio, video });
    });
    on(SERVER_EVENTS.CHAT_MESSAGE, ({ message }) => {
      this.#dispatch({ type: ACTIONS.CHAT_MESSAGE, message });
    });
    on(SIGNALING_EVENTS.DISCONNECTED, (event) => this.#handleDisconnected(event));
  }

  /**
   * Обрыв соединения (FR-31, TDD §7.6): переподключения нет, сессия закончилась. Выход по
   * кнопке сюда не попадает — там причина `io client disconnect`, а `LEFT` уже отправлен.
   */
  #handleDisconnected({ byClient }) {
    if (byClient || !this.#inRoom) return;
    this.#inRoom = false;
    this.#started = false;
    this.#cleanup();
    this.#dispatch({ type: ACTIONS.CONNECTION_LOST });
  }

  /** Экран ошибки входа: следующий `start` разрешён — это «Повторить вход» (TDD §4.1.2). */
  #fail(code) {
    this.#started = false;
    this.#dispatch({ type: ACTIONS.JOIN_FAILED, error: code });
  }

  #cleanup() {
    for (const unsubscribe of this.#unsubscribes.splice(0)) unsubscribe();
  }
}
