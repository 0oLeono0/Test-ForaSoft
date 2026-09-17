// Модель Socket.io для unit-тестов обработчиков: комнаты, рассылки и ack без сети. Повторяет
// поведение Socket.io 4 с in-memory adapter: сокет всегда состоит в комнате со своим id,
// `socket.to(room)` не доставляет отправителю, перед событием `disconnect` сокет покидает все
// комнаты, payload проходит через JSON. Настоящий сервер проверяют интеграционные тесты.
import { vi } from 'vitest';
import { RoomManager } from '../src/rooms/RoomManager.js';
import { RateLimiter } from '../src/socket/rateLimiter.js';
import { registerHandlers } from '../src/socket/registerHandlers.js';

export const ICE_SERVERS = Object.freeze([Object.freeze({ urls: 'stun:stun.l.google.com:19302' })]);

/** Как транспорт Socket.io: `undefined`-поля пропадают, объекты копируются. */
function serialize(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export class FakeIo {
  /** @type {Map<string, FakeSocket>} */
  sockets = new Map();
  #connectionListeners = [];

  on(event, listener) {
    if (event !== 'connection') throw new Error(`FakeIo: событие ${event} не поддерживается`);
    this.#connectionListeners.push(listener);
  }

  to(room) {
    return { emit: (event, payload) => this.deliver(room, event, payload, null) };
  }

  /** Подключает клиента: сервер получает `connection`. */
  connect(id = `socket-${this.sockets.size + 1}`) {
    const socket = new FakeSocket(this, id);
    this.sockets.set(id, socket);
    for (const listener of this.#connectionListeners) listener(socket);
    return socket;
  }

  deliver(room, event, payload, except) {
    for (const socket of this.sockets.values()) {
      if (socket !== except && socket.rooms.has(room)) socket.emit(event, payload);
    }
  }
}

export class FakeSocket {
  data = {};
  connected = true;
  /** События сервер → этот клиент в порядке доставки: `{ event, payload }`. */
  received = [];
  #io;
  #listeners = new Map();

  constructor(io, id) {
    this.#io = io;
    this.id = id;
    this.rooms = new Set([id]);
  }

  // Серверная сторона сокета: то, что вызывают обработчики.

  on(event, listener) {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
  }

  join(room) {
    if (this.connected) this.rooms.add(room);
  }

  leave(room) {
    this.rooms.delete(room);
  }

  to(room) {
    return { emit: (event, payload) => this.#io.deliver(room, event, payload, this) };
  }

  emit(event, payload) {
    if (this.connected) this.received.push({ event, payload: serialize(payload) });
  }

  // Клиентская сторона: то, что делает браузер.

  /** `socket.emit(event, ...args)` клиента; функция в аргументах — ack. */
  send(event, ...args) {
    const serialized = args.map((arg) => (typeof arg === 'function' ? arg : serialize(arg)));
    for (const listener of this.#listeners.get(event) ?? []) listener(...serialized);
  }

  /**
   * `emitWithAck` клиента: ответ сервера или `undefined`, если ack не вызван. Как в Socket.io,
   * доставляется только первый вызов ack.
   */
  request(event, ...args) {
    const responses = [];
    this.send(event, ...args, (response) => responses.push(serialize(response)));
    return responses[0];
  }

  disconnect(reason = 'transport close') {
    this.connected = false;
    this.rooms.clear();
    for (const listener of this.#listeners.get('disconnect') ?? []) listener(reason);
  }

  /** Payload полученных событий `event` по порядку. */
  eventsOf(event) {
    return this.received.filter((entry) => entry.event === event).map((entry) => entry.payload);
  }

  /** Забыть полученные события, чтобы проверять только новые. */
  clearReceived() {
    this.received.length = 0;
  }
}

export function fakeLogger() {
  return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * Сервер из FakeIo и настоящих RoomManager, RateLimiter и обработчиков.
 * @param {{ roomManager?: RoomManager, rateLimiter?: RateLimiter }} [overrides]
 */
export function createTestbed({
  roomManager = new RoomManager(),
  rateLimiter = new RateLimiter(),
} = {}) {
  const io = new FakeIo();
  const logger = fakeLogger();
  registerHandlers(io, { roomManager, rateLimiter, logger, iceServers: ICE_SERVERS });

  /** Подключается и входит в комнату; падает, если вход не удался. Возвращает сокет и ack. */
  const joinAs = (name, roomId = 'V1StGXR8_Z') => {
    const socket = io.connect();
    const ack = socket.request('room:join', { roomId, name });
    if (!ack?.ok) throw new Error(`вход ${name} в ${roomId}: ${JSON.stringify(ack)}`);
    return { socket, ack, id: ack.self.id };
  };

  return { io, roomManager, rateLimiter, logger, joinAs };
}
