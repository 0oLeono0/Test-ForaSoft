import { CLIENT_EVENTS, ERROR_CODES, SERVER_EVENTS } from '@vcr/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_ERROR_CODES } from '../utils/mediaErrors.js';
import {
  CLIENT_DISCONNECT_REASON,
  CONNECT_TIMEOUT_MS,
  SIGNALING_EVENTS,
  SignalingClient,
  SignalingError,
  createSignalingClient,
} from './SignalingClient.js';

/**
 * Мок сокета с тем интерфейсом, которым пользуется `SignalingClient`: подписки, `emit`,
 * `emitWithAck` и ручное управление подключением.
 */
function createSocketMock() {
  const listeners = new Map();
  /** @type {{ event: string, payload: unknown }[]} */
  const emitted = [];
  /** @type {{ event: string, payload: unknown, resolve: Function, reject: Function }[]} */
  const pending = [];

  const socket = {
    connected: false,
    emitted,
    pending,
    on: vi.fn((event, handler) => {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(handler);
      listeners.set(event, handlers);
    }),
    off: vi.fn((event, handler) => {
      listeners.get(event)?.delete(handler);
    }),
    emit: vi.fn((event, payload) => {
      emitted.push({ event, payload });
    }),
    emitWithAck: vi.fn(
      (event, payload) =>
        new Promise((resolve, reject) => {
          pending.push({ event, payload, resolve, reject });
        }),
    ),
    connect: vi.fn(),
    disconnect: vi.fn(() => {
      socket.connected = false;
      socket.fire('disconnect', CLIENT_DISCONNECT_REASON);
    }),
    /** Сервер (или транспорт) прислал событие. */
    fire(event, ...args) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(...args);
    },
    /** Успешное подключение. */
    open() {
      socket.connected = true;
      socket.fire('connect');
    },
    /** Ответ на самый ранний неотвеченный ack-запрос. */
    ack(value) {
      pending.shift().resolve(value);
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
  return socket;
}

let socket;
let client;

beforeEach(() => {
  vi.useFakeTimers();
  socket = createSocketMock();
  client = new SignalingClient(socket);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createSignalingClient', () => {
  it('создаётся на настоящем socket.io-client, не подключаясь', () => {
    // Socket.io дописывает свои поля в переданные опции: замороженную константу отдавать нельзя.
    vi.useRealTimers();

    const client = createSignalingClient();

    expect(client).toBeInstanceOf(SignalingClient);
    client.disconnect();
  });
});

describe('SignalingClient.connect', () => {
  it('подключается и снимает временные подписки', async () => {
    const promise = client.connect();
    socket.open();

    await expect(promise).resolves.toBeUndefined();
    expect(socket.connect).toHaveBeenCalledOnce();
    expect(socket.listenerCount('connect')).toBe(0);
    expect(socket.listenerCount('connect_error')).toBe(0);
  });

  it('таймаут подключения: SERVER_UNAVAILABLE (FR-35, TDD §8.2)', async () => {
    const promise = client.connect({ timeoutMs: CONNECT_TIMEOUT_MS });
    const assertion = expect(promise).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.SERVER_UNAVAILABLE,
    });
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);

    await assertion;
    expect(socket.listenerCount('connect')).toBe(0);
  });

  it('connect_error: SERVER_UNAVAILABLE', async () => {
    const promise = client.connect();
    socket.fire('connect_error', new Error('ECONNREFUSED'));

    await expect(promise).rejects.toBeInstanceOf(SignalingError);
  });

  it('уже подключённый сокет: повторное подключение не выполняется (TDD §4.1.2)', async () => {
    socket.connected = true;

    await expect(client.connect()).resolves.toBeUndefined();
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it('поздний connect_error после успеха промис не отклоняет', async () => {
    const promise = client.connect();
    socket.open();
    await promise;

    // Подписки сняты, поэтому необработанного reject не возникает.
    expect(() => socket.fire('connect_error', new Error('late'))).not.toThrow();
  });
});

describe('SignalingClient: ack-запросы', () => {
  it('join отдаёт данные ack (TDD §6.3)', async () => {
    const promise = client.join('V1StGXR8_Z', 'Алекс');
    expect(socket.emitWithAck).toHaveBeenCalledWith(CLIENT_EVENTS.ROOM_JOIN, {
      roomId: 'V1StGXR8_Z',
      name: 'Алекс',
    });

    socket.ack({ ok: true, self: { id: 'b7c1' }, participants: [], messages: [] });

    await expect(promise).resolves.toMatchObject({ self: { id: 'b7c1' } });
  });

  it('ошибка ack превращается в SignalingError с кодом сервера (TDD §8.1)', async () => {
    const promise = client.join('V1StGXR8_Z', 'Алекс');
    socket.ack({ ok: false, error: { code: ERROR_CODES.ROOM_FULL, message: 'Комната заполнена' } });

    await expect(promise).rejects.toMatchObject({
      code: ERROR_CODES.ROOM_FULL,
      message: 'Комната заполнена',
    });
  });

  it('ответ без ok считается ошибкой, а не успехом', async () => {
    const promise = client.join('V1StGXR8_Z', 'Алекс');
    socket.ack(undefined);

    await expect(promise).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.SERVER_UNAVAILABLE,
    });
  });

  it('таймаут ack: SERVER_UNAVAILABLE', async () => {
    const promise = client.sendChat('Привет');
    const assertion = expect(promise).rejects.toMatchObject({
      code: CLIENT_ERROR_CODES.SERVER_UNAVAILABLE,
    });
    await vi.advanceTimersByTimeAsync(CONNECT_TIMEOUT_MS);

    await assertion;
  });

  it('sendChat отдаёт сообщение из ack, leave ждёт подтверждения (TDD §6.3)', async () => {
    const chat = client.sendChat('Привет');
    socket.ack({ ok: true, message: { id: 'm1', text: 'Привет' } });
    await expect(chat).resolves.toMatchObject({ id: 'm1' });

    const leave = client.leave();
    expect(socket.emitWithAck).toHaveBeenLastCalledWith(CLIENT_EVENTS.ROOM_LEAVE, {});
    socket.ack({ ok: true });
    await expect(leave).resolves.toBeUndefined();
  });
});

describe('SignalingClient: события без ack', () => {
  it('sendMediaState и sendSignal отправляют payload из контракта (TDD §6.3)', () => {
    client.sendMediaState({ audio: true, video: false });
    client.sendSignal('4f2a', { type: 'offer', sdp: 'v=0' });

    expect(socket.emitted).toEqual([
      { event: CLIENT_EVENTS.MEDIA_STATE, payload: { audio: true, video: false } },
      { event: CLIENT_EVENTS.SIGNAL, payload: { to: '4f2a', data: { type: 'offer', sdp: 'v=0' } } },
    ]);
  });

  it('лишние поля в media:state не уходят на сервер', () => {
    client.sendMediaState({ audio: true, video: true, screen: true });

    expect(socket.emitted[0].payload).toEqual({ audio: true, video: true });
  });
});

describe('SignalingClient.on', () => {
  it('подписка на событие сервера и отписка', () => {
    const handler = vi.fn();
    const unsubscribe = client.on(SERVER_EVENTS.CHAT_MESSAGE, handler);

    socket.fire(SERVER_EVENTS.CHAT_MESSAGE, { message: { id: 'm1' } });
    expect(handler).toHaveBeenCalledWith({ message: { id: 'm1' } });

    unsubscribe();
    socket.fire(SERVER_EVENTS.CHAT_MESSAGE, { message: { id: 'm2' } });
    expect(handler).toHaveBeenCalledOnce();
  });

  it('обрыв транспорта и выход по кнопке различаются (TDD §7.6, §8.2)', () => {
    const handler = vi.fn();
    client.on(SIGNALING_EVENTS.DISCONNECTED, handler);

    socket.fire('disconnect', 'transport close');
    expect(handler).toHaveBeenCalledWith({ reason: 'transport close', byClient: false });

    client.disconnect();
    expect(handler).toHaveBeenLastCalledWith({
      reason: CLIENT_DISCONNECT_REASON,
      byClient: true,
    });
  });

  it('отписка от disconnected снимает только свой обработчик', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = client.on(SIGNALING_EVENTS.DISCONNECTED, first);
    client.on(SIGNALING_EVENTS.DISCONNECTED, second);

    unsubscribe();
    socket.fire('disconnect', 'ping timeout');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});
