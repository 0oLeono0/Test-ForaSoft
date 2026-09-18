import { ERROR_CODES, ERROR_MESSAGES, SERVER_EVENTS } from '@vcr/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIONS, PHASES, initialState, roomReducer } from '../state/roomReducer.js';
import { clear as clearToasts, getSnapshot as toastSnapshot } from '../state/toasts.js';
import { CLIENT_ERROR_CODES } from '../utils/mediaErrors.js';
import { RoomSession } from './RoomSession.js';
import { SIGNALING_EVENTS, SignalingError } from './SignalingClient.js';

const ROOM_ID = 'V1StGXR8_Z';
const SELF = { id: 'b7c1', name: 'Алекс', audio: false, video: false };
const MARIA = { id: '4f2a', name: 'Мария', audio: true, video: true };

/** Ответ `room:join` из TDD §6.5. */
function joinAck(overrides = {}) {
  return {
    ok: true,
    self: SELF,
    participants: [MARIA],
    messages: [],
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    limits: { messageMaxLength: 1000 },
    ...overrides,
  };
}

/** Мок `SignalingClient`: ответы задаются тестом, события поднимаются вручную. */
function createSignalingMock() {
  const listeners = new Map();

  return {
    listeners,
    connect: vi.fn(() => Promise.resolve()),
    join: vi.fn(() => Promise.resolve(joinAck())),
    leave: vi.fn(() => Promise.resolve()),
    sendChat: vi.fn(() => Promise.resolve({ id: 'm1' })),
    sendMediaState: vi.fn(),
    sendSignal: vi.fn(),
    disconnect: vi.fn(),
    on: vi.fn((event, handler) => {
      const handlers = listeners.get(event) ?? new Set();
      handlers.add(handler);
      listeners.set(event, handlers);
      return () => handlers.delete(handler);
    }),
    /** Сервер прислал событие. */
    fire(event, payload) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
    },
    listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
    totalListeners() {
      return [...listeners.values()].reduce((sum, handlers) => sum + handlers.size, 0);
    },
  };
}

/** Собирает состояние так же, как `useReducer` в `RoomPage`: действия прогоняются через reducer. */
function setup({ checkSupport = () => ({ ok: true }) } = {}) {
  const signaling = createSignalingMock();
  let state = initialState;
  const actions = [];
  const dispatch = vi.fn((action) => {
    actions.push(action);
    state = roomReducer(state, action);
  });
  const session = new RoomSession({ dispatch, signaling, checkSupport });

  return { session, signaling, actions, state: () => state };
}

afterEach(() => {
  clearToasts();
});

describe('RoomSession.start: успешный вход', () => {
  it('фазы, JOIN_OK и данные ack (FR-4, TDD §4.1.2, §6.3)', async () => {
    const { session, signaling, actions, state } = setup();

    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    expect(actions.map((action) => action.phase ?? action.type)).toEqual([
      PHASES.CHECKING_ENV,
      PHASES.CONNECTING,
      PHASES.JOINING,
      ACTIONS.JOIN_OK,
    ]);
    expect(signaling.join).toHaveBeenCalledWith(ROOM_ID, 'Алекс');
    expect(state()).toMatchObject({
      phase: PHASES.IN_ROOM,
      roomId: ROOM_ID,
      selfId: SELF.id,
      // В ack участники идут без себя: сам вошедший встаёт последним (TDD §6.3).
      participants: [MARIA, SELF],
    });
    expect(session.selfId).toBe(SELF.id);
    expect(session.limits).toEqual({ messageMaxLength: 1000 });
    expect(session.iceServers).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
  });

  it('второй start во время входа игнорируется (TDD §8.3)', async () => {
    const { session, signaling } = setup();

    await Promise.all([
      session.start({ roomId: ROOM_ID, name: 'Алекс' }),
      session.start({ roomId: ROOM_ID, name: 'Алекс' }),
    ]);

    expect(signaling.join).toHaveBeenCalledOnce();
  });

  it('ALREADY_IN_ROOM не рушит экран комнаты (TDD §8.1)', async () => {
    const { session, signaling, actions } = setup();
    signaling.join.mockRejectedValueOnce(new SignalingError(ERROR_CODES.ALREADY_IN_ROOM));

    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    expect(actions.some(({ type }) => type === ACTIONS.JOIN_FAILED)).toBe(false);
  });
});

describe('RoomSession.start: отказы', () => {
  it.each([
    ['ROOM_FULL → экран «Комната заполнена» (FR-8, US-5)', ERROR_CODES.ROOM_FULL, PHASES.ROOM_FULL],
    ['INVALID_NAME → обратно на форму имени', ERROR_CODES.INVALID_NAME, PHASES.NAME_FORM],
    ['INTERNAL_ERROR → общий экран отказа', ERROR_CODES.INTERNAL_ERROR, PHASES.JOIN_ERROR],
  ])('%s', async (_, code, phase) => {
    const { session, signaling, state } = setup();
    signaling.join.mockRejectedValueOnce(new SignalingError(code));

    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    expect(state()).toMatchObject({ phase, error: code });
  });

  it('сервер недоступен: SERVER_UNAVAILABLE, join не вызывается (FR-35)', async () => {
    const { session, signaling, state } = setup();
    signaling.connect.mockRejectedValueOnce(
      new SignalingError(CLIENT_ERROR_CODES.SERVER_UNAVAILABLE),
    );

    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    expect(state()).toMatchObject({ phase: PHASES.SERVER_UNAVAILABLE });
    expect(signaling.join).not.toHaveBeenCalled();
  });

  it('«Повторить вход» после отказа запускает новый вход', async () => {
    const { session, signaling, state } = setup();
    signaling.join.mockRejectedValueOnce(new SignalingError(ERROR_CODES.ROOM_FULL));

    await session.start({ roomId: ROOM_ID, name: 'Алекс' });
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    expect(signaling.join).toHaveBeenCalledTimes(2);
    expect(state()).toMatchObject({ phase: PHASES.IN_ROOM });
  });

  it.each([
    ['незащищённый контекст', CLIENT_ERROR_CODES.INSECURE_CONTEXT, PHASES.INSECURE_CONTEXT],
    ['нет WebRTC', CLIENT_ERROR_CODES.WEBRTC_UNSUPPORTED, PHASES.UNSUPPORTED],
  ])('%s: до сервера дело не доходит (FR-36, TDD §4.1.2)', async (_, reason, phase) => {
    const { session, signaling, state } = setup({ checkSupport: () => ({ ok: false, reason }) });

    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    expect(state()).toMatchObject({ phase, error: reason });
    expect(signaling.connect).not.toHaveBeenCalled();
  });

  it('недопустимый roomId проверяется до подключения (TDD §8.3)', async () => {
    const { session, signaling, state } = setup();

    await session.start({ roomId: '<script>', name: 'Алекс' });

    expect(state()).toMatchObject({
      phase: PHASES.JOIN_ERROR,
      error: ERROR_CODES.INVALID_ROOM_ID,
    });
    expect(signaling.connect).not.toHaveBeenCalled();
  });
});

describe('RoomSession: события комнаты', () => {
  it('участник вошёл, сменил состояние устройств и вышел (FR-26, FR-27)', async () => {
    const { session, signaling, state } = setup();
    signaling.join.mockResolvedValueOnce(joinAck({ participants: [] }));
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    signaling.fire(SERVER_EVENTS.PARTICIPANT_JOINED, { participant: MARIA });
    expect(state().participants).toEqual([SELF, MARIA]);

    signaling.fire(SERVER_EVENTS.PARTICIPANT_MEDIA, {
      participantId: MARIA.id,
      audio: false,
      video: true,
    });
    expect(state().participants[1]).toMatchObject({ audio: false, video: true });

    signaling.fire(SERVER_EVENTS.PARTICIPANT_LEFT, { participantId: MARIA.id });
    expect(state().participants).toEqual([SELF]);
  });

  it('сообщения чата попадают в ленту без дублей (FR-23, TDD §6.4)', async () => {
    const { session, signaling, state } = setup();
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    const message = { id: 'm1', type: 'user', authorId: MARIA.id, text: 'Привет', ts: 1 };
    signaling.fire(SERVER_EVENTS.CHAT_MESSAGE, { message });
    signaling.fire(SERVER_EVENTS.CHAT_MESSAGE, { message });

    expect(state().messages).toEqual([message]);
  });

  it('подписки ставятся до отправки room:join', async () => {
    // Иначе событие о следующем участнике, пришедшее сразу за ack, было бы потеряно.
    const { session, signaling } = setup();
    let subscribedBeforeJoin = false;
    signaling.join.mockImplementationOnce(() => {
      subscribedBeforeJoin = signaling.listenerCount(SERVER_EVENTS.CHAT_MESSAGE) === 1;
      return Promise.resolve(joinAck());
    });

    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    expect(subscribedBeforeJoin).toBe(true);
  });
});

describe('RoomSession.sendMessage', () => {
  it('успех: true и никаких уведомлений (FR-21)', async () => {
    const { session, signaling } = setup();
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    await expect(session.sendMessage('Привет')).resolves.toBe(true);
    expect(signaling.sendChat).toHaveBeenCalledWith('Привет');
    expect(toastSnapshot()).toEqual([]);
  });

  it.each([
    ['слишком длинное сообщение', ERROR_CODES.MESSAGE_TOO_LONG],
    ['слишком часто', ERROR_CODES.RATE_LIMITED],
  ])('%s: toast, текст остаётся в поле (TDD §8.1)', async (_, code) => {
    const { session, signaling } = setup();
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });
    signaling.sendChat.mockRejectedValueOnce(new SignalingError(code, ERROR_MESSAGES[code]));

    await expect(session.sendMessage('Привет')).resolves.toBe(false);
    expect(toastSnapshot()).toEqual([{ id: expect.any(Number), text: ERROR_MESSAGES[code] }]);
  });

  it('NOT_IN_ROOM не показывается пользователю (TDD §8.1)', async () => {
    const { session, signaling } = setup();
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });
    signaling.sendChat.mockRejectedValueOnce(new SignalingError(ERROR_CODES.NOT_IN_ROOM));

    await expect(session.sendMessage('Привет')).resolves.toBe(false);
    expect(toastSnapshot()).toEqual([]);
  });

  it('таймаут ack: показывается запасной текст', async () => {
    const { session, signaling } = setup();
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });
    signaling.sendChat.mockRejectedValueOnce(
      new SignalingError(CLIENT_ERROR_CODES.SERVER_UNAVAILABLE),
    );

    await session.sendMessage('Привет');

    expect(toastSnapshot()[0].text).toMatch(/не отправлено/i);
  });
});

describe('RoomSession.leave и обрыв связи', () => {
  it('выход: ack, закрытие сокета, LEFT и снятые подписки (FR-27, US-10)', async () => {
    const { session, signaling, state } = setup();
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    await session.leave();

    expect(signaling.leave).toHaveBeenCalledOnce();
    expect(signaling.disconnect).toHaveBeenCalledOnce();
    expect(state()).toMatchObject({ phase: PHASES.LEFT, participants: [] });
    expect(signaling.totalListeners()).toBe(0);
  });

  it('ошибка ack при выходе не мешает закрыть сокет', async () => {
    const { session, signaling, state } = setup();
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });
    signaling.leave.mockRejectedValueOnce(new SignalingError(ERROR_CODES.NOT_IN_ROOM));

    await session.leave();

    expect(signaling.disconnect).toHaveBeenCalledOnce();
    expect(state().phase).toBe(PHASES.LEFT);
  });

  it('обрыв не по инициативе клиента: CONNECTION_LOST (FR-31, TDD §7.6)', async () => {
    const { session, signaling, state } = setup();
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    signaling.fire(SIGNALING_EVENTS.DISCONNECTED, { reason: 'transport close', byClient: false });

    expect(state()).toMatchObject({
      phase: PHASES.CONNECTION_LOST,
      error: CLIENT_ERROR_CODES.CONNECTION_LOST,
      participants: [],
    });
    expect(signaling.totalListeners()).toBe(0);
  });

  it('после выхода обрыв сокета экран не меняет', async () => {
    const { session, signaling, state } = setup();
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });
    await session.leave();

    signaling.fire(SIGNALING_EVENTS.DISCONNECTED, {
      reason: 'io client disconnect',
      byClient: true,
    });

    expect(state().phase).toBe(PHASES.LEFT);
  });

  it('«Войти заново» после обрыва: подписки ставятся заново', async () => {
    const { session, signaling, state } = setup();
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });
    signaling.fire(SIGNALING_EVENTS.DISCONNECTED, { reason: 'ping timeout', byClient: false });

    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    expect(state().phase).toBe(PHASES.IN_ROOM);
    expect(signaling.listenerCount(SERVER_EVENTS.CHAT_MESSAGE)).toBe(1);
  });
});

describe('RoomSession.destroy', () => {
  let session;
  let signaling;
  let actions;

  beforeEach(async () => {
    ({ session, signaling, actions } = setup());
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });
  });

  it('снимает подписки и закрывает сокет', () => {
    session.destroy();

    expect(signaling.totalListeners()).toBe(0);
    expect(signaling.disconnect).toHaveBeenCalledOnce();
  });

  it('повторный вызов и события после него ничего не делают', () => {
    session.destroy();
    const dispatched = actions.length;

    session.destroy();
    signaling.fire(SERVER_EVENTS.CHAT_MESSAGE, { message: { id: 'm9' } });

    expect(signaling.disconnect).toHaveBeenCalledOnce();
    expect(actions).toHaveLength(dispatched);
  });

  it('после destroy вход и выход не трогают состояние', async () => {
    session.destroy();
    const dispatched = actions.length;

    await session.start({ roomId: ROOM_ID, name: 'Алекс' });
    await session.leave();

    expect(actions).toHaveLength(dispatched);
  });

  it('размонтирование во время входа: JOIN_OK не отправляется', async () => {
    const fresh = setup();
    let resolveJoin;
    const joinSent = new Promise((markSent) => {
      fresh.signaling.join.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveJoin = resolve;
            markSent();
          }),
      );
    });

    const started = fresh.session.start({ roomId: ROOM_ID, name: 'Алекс' });
    await joinSent;
    fresh.session.destroy();
    resolveJoin(joinAck());
    await started;

    expect(fresh.actions.some(({ type }) => type === ACTIONS.JOIN_OK)).toBe(false);
  });
});
