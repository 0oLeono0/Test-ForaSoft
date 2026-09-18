// Обёртка над socket.io-client: подключение, ack-запросы с таймаутом, подписки (TDD §4.1.3, §6.2).
//
// Автопереподключения нет (FR-31): обрыв соединения — это конец сессии, а не пауза. Поэтому
// `reconnection: false`, а обрыв превращается в событие `disconnected` с признаком «по инициативе
// клиента»: выход по кнопке от потери связи отличается только причиной (TDD §7.6, §8.2).
import { CLIENT_EVENTS } from '@vcr/shared';
import { io } from 'socket.io-client';
import { CLIENT_ERROR_CODES } from '../utils/mediaErrors.js';

/** Сколько ждём `connect` и ack (TDD §6.2, §8.2). */
export const CONNECT_TIMEOUT_MS = 5000;

/** Причина `disconnect`, которую Socket.io ставит после нашего же `socket.disconnect()`. */
export const CLIENT_DISCONNECT_REASON = 'io client disconnect';

/** Локальное событие клиента: у сокета такого имени нет (TDD §7.6). */
export const SIGNALING_EVENTS = Object.freeze({ DISCONNECTED: 'disconnected' });

/** Опции подключения из TDD §6.2: без автоподключения и без переподключения. */
export const SOCKET_OPTIONS = Object.freeze({
  autoConnect: false,
  reconnection: false,
  timeout: CONNECT_TIMEOUT_MS,
});

/**
 * Ошибка сигналинга: `code` — из `ERROR_CODES` (ответ сервера) или из `CLIENT_ERROR_CODES`
 * (таймаут, недоступный сервер). По нему вызывающий выбирает экран или toast (TDD §8.1, §8.2).
 */
export class SignalingError extends Error {
  /**
   * @param {string} code
   * @param {string} [message]  текст сервера; по умолчанию совпадает с кодом
   */
  constructor(code, message = code) {
    super(message);
    this.name = 'SignalingError';
    this.code = code;
  }
}

/** Ответ без `ok: true` — сломанный контракт: обрабатываем как ошибку, а не как успех. */
function unwrapAck(ack) {
  if (ack?.ok === true) return ack;
  const error = ack?.error;
  throw new SignalingError(
    error?.code ?? CLIENT_ERROR_CODES.SERVER_UNAVAILABLE,
    error?.message ?? 'Сервер вернул некорректный ответ',
  );
}

export class SignalingClient {
  /** @type {import('socket.io-client').Socket} */
  #socket;
  /** @type {Map<string, Set<Function>>} подписки на локальные события клиента */
  #localListeners = new Map();

  /** @param {import('socket.io-client').Socket} socket  в тестах — мок с тем же интерфейсом */
  constructor(socket) {
    this.#socket = socket;
    this.#socket.on('disconnect', (reason) => {
      this.#emitLocal(SIGNALING_EVENTS.DISCONNECTED, {
        reason,
        byClient: reason === CLIENT_DISCONNECT_REASON,
      });
    });
  }

  /**
   * Подключение с таймаутом. Уже подключённый сокет («Повторить вход» после `ROOM_FULL`)
   * разрешает промис сразу — заново подключаться не нужно (TDD §4.1.2).
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<void>}  reject `SignalingError(SERVER_UNAVAILABLE)` (TDD §8.2)
   */
  connect({ timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
    if (this.#socket.connected) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => settle(new SignalingError(CLIENT_ERROR_CODES.SERVER_UNAVAILABLE)),
        timeoutMs,
      );
      const onConnect = () => settle(null);
      const onError = () => settle(new SignalingError(CLIENT_ERROR_CODES.SERVER_UNAVAILABLE));

      const settle = (error) => {
        clearTimeout(timer);
        this.#socket.off('connect', onConnect);
        this.#socket.off('connect_error', onError);
        if (error === null) resolve();
        else reject(error);
      };

      this.#socket.on('connect', onConnect);
      this.#socket.on('connect_error', onError);
      this.#socket.connect();
    });
  }

  /**
   * @param {string} roomId
   * @param {string} name
   * @returns {Promise<import('@vcr/shared').JoinAckData>}
   */
  join(roomId, name) {
    return this.#request(CLIENT_EVENTS.ROOM_JOIN, { roomId, name });
  }

  /** @returns {Promise<void>} */
  async leave() {
    await this.#request(CLIENT_EVENTS.ROOM_LEAVE, {});
  }

  /**
   * @param {string} text
   * @returns {Promise<import('@vcr/shared').ChatMessage>}
   */
  async sendChat(text) {
    const ack = await this.#request(CLIENT_EVENTS.CHAT_SEND, { text });
    return ack.message;
  }

  /**
   * Состояние тумблеров. Ack не предусмотрен (TDD §6.3): индикатор у остальных — не тот случай,
   * ради которого стоит блокировать кнопку.
   * @param {{ audio: boolean, video: boolean }} state
   */
  sendMediaState({ audio, video }) {
    this.#socket.emit(CLIENT_EVENTS.MEDIA_STATE, { audio, video });
  }

  /**
   * SDP и ICE-кандидаты. Ошибки приходят отдельным событием `signal:error` (TDD §6.3).
   * @param {string} to  participantId получателя
   * @param {import('@vcr/shared').SignalData} data
   */
  sendSignal(to, data) {
    this.#socket.emit(CLIENT_EVENTS.SIGNAL, { to, data });
  }

  /**
   * @param {string} event  имя из `SERVER_EVENTS` или `SIGNALING_EVENTS`
   * @param {Function} handler
   * @returns {() => void} отписка; вызывать её повторно безопасно
   */
  on(event, handler) {
    if (isLocalEvent(event)) {
      const handlers = this.#localListeners.get(event) ?? new Set();
      handlers.add(handler);
      this.#localListeners.set(event, handlers);
      return () => handlers.delete(handler);
    }
    this.#socket.on(event, handler);
    return () => this.#socket.off(event, handler);
  }

  /** Выход по инициативе клиента: причина `disconnect` будет `io client disconnect` (TDD §7.6). */
  disconnect() {
    this.#socket.disconnect();
  }

  /**
   * Ack с таймаутом. Поздний ответ после таймаута игнорируется: промис уже отклонён, а
   * переподключения, которое могло бы его принести, нет.
   */
  #request(event, payload, timeoutMs = CONNECT_TIMEOUT_MS) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new SignalingError(CLIENT_ERROR_CODES.SERVER_UNAVAILABLE)),
        timeoutMs,
      );
    });

    return Promise.race([
      this.#socket.emitWithAck(event, payload).then(unwrapAck),
      timeout,
    ]).finally(() => clearTimeout(timer));
  }

  #emitLocal(event, payload) {
    // Копия: обработчик вправе отписаться прямо во время вызова.
    for (const handler of [...(this.#localListeners.get(event) ?? [])]) handler(payload);
  }
}

function isLocalEvent(event) {
  return Object.values(SIGNALING_EVENTS).includes(event);
}

/** Боевой клиент: адрес берётся из текущего origin, путь `/socket.io` (TDD §6.2). */
export function createSignalingClient() {
  // Копия обязательна: Socket.io дописывает в переданные опции свои поля (`path`, `query`),
  // а замороженный объект-константу этим не расширить.
  return new SignalingClient(io({ ...SOCKET_OPTIONS }));
}
