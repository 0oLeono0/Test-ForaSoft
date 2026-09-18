import { ERROR_CODES, ERROR_MESSAGES, SERVER_EVENTS } from '@vcr/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIONS, LINK_STATUS, PHASES, initialState, roomReducer } from '../state/roomReducer.js';
import { clear as clearToasts, getSnapshot as toastSnapshot } from '../state/toasts.js';
import {
  CLIENT_ERROR_CODES,
  DEVICE_LOST_MESSAGE,
  TRACK_STATUS,
  deviceErrorMessage,
} from '../utils/mediaErrors.js';
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

function localTrack(kind) {
  return { kind, id: `local-${kind}`, enabled: true };
}

/** Оба устройства доступны — обычный исход `acquire()`. */
function okAcquire() {
  return {
    audio: { status: TRACK_STATUS.OK, track: localTrack('audio') },
    video: { status: TRACK_STATUS.OK, track: localTrack('video') },
  };
}

/**
 * Мок `MediaManager`: держит дорожки и статусы, как настоящий, но без `getUserMedia`.
 * Тест задаёт исход захвата и может задержать его, чтобы проверить параллельность (TDD §7.2).
 */
function createMediaMock() {
  const tracks = { audio: null, video: null };
  const statuses = { audio: null, video: null };
  const listeners = { track: new Set(), lost: new Set() };
  let result = okAcquire();
  let gate = null;

  const media = {
    localStream: { id: 'local-stream' },

    acquire: vi.fn(async () => {
      if (gate !== null) await gate;
      for (const kind of ['audio', 'video']) {
        tracks[kind] = result[kind].track;
        statuses[kind] = result[kind].status;
      }
      return result;
    }),
    getTrack: vi.fn((kind) => tracks[kind]),
    getStatus: vi.fn((kind) => statuses[kind]),
    getMediaState: vi.fn(() => ({
      audio: tracks.audio !== null && tracks.audio.enabled !== false,
      video: tracks.video !== null,
    })),
    setAudioEnabled: vi.fn(async (enabled) => {
      if (tracks.audio !== null) {
        tracks.audio.enabled = enabled;
        return statuses.audio;
      }
      if (!enabled) return statuses.audio;
      tracks.audio = localTrack('audio');
      statuses.audio = TRACK_STATUS.OK;
      media.emitTrackChange('audio', tracks.audio);
      return statuses.audio;
    }),
    setVideoEnabled: vi.fn(async (enabled) => {
      if (!enabled) {
        tracks.video = null;
        media.emitTrackChange('video', null);
        return statuses.video;
      }
      if (tracks.video !== null) return statuses.video;
      tracks.video = localTrack('video');
      statuses.video = TRACK_STATUS.OK;
      media.emitTrackChange('video', tracks.video);
      return statuses.video;
    }),
    onTrackChange: vi.fn((handler) => {
      listeners.track.add(handler);
      return () => listeners.track.delete(handler);
    }),
    onDeviceLost: vi.fn((handler) => {
      listeners.lost.add(handler);
      return () => listeners.lost.delete(handler);
    }),
    dispose: vi.fn(),

    /** Исход следующего `acquire()`: отказ, занятое устройство, отсутствие камеры. */
    setAcquireResult(next) {
      result = next;
    },
    /** Держит `acquire()` до вызова возвращённой функции — как открытый диалог разрешений. */
    blockAcquire() {
      let release;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        gate = null;
        release();
      };
    },
    emitTrackChange(kind, track) {
      for (const handler of [...listeners.track]) handler(kind, track);
    },
    /** Устройство выдернули во время звонка (FR-20). */
    emitDeviceLost(kind) {
      tracks[kind] = null;
      media.emitTrackChange(kind, null);
      for (const handler of [...listeners.lost]) handler(kind);
    },
  };
  return media;
}

/** Мок `PeerMesh`: маршрутизация и статусы проверяются в его собственных тестах. */
function createMeshMock() {
  const statusHandlers = new Set();

  return {
    connectTo: vi.fn(),
    handleSignal: vi.fn(async () => {}),
    removePeer: vi.fn(),
    broadcastTrack: vi.fn(),
    getStream: vi.fn((peerId) => ({ id: `stream-${peerId}` })),
    closeAll: vi.fn(),
    onStatus: vi.fn((handler) => {
      statusHandlers.add(handler);
      return () => statusHandlers.delete(handler);
    }),
    emitStatus(peerId, status) {
      for (const handler of [...statusHandlers]) handler(peerId, status);
    },
  };
}

/** Захват идёт параллельно входу, и `start` его не ждёт: даём промисам дорешать. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Собирает состояние так же, как `useReducer` в `RoomPage`: действия прогоняются через reducer. */
function setup({ checkSupport = () => ({ ok: true }) } = {}) {
  const signaling = createSignalingMock();
  const media = createMediaMock();
  const mesh = createMeshMock();
  let meshDeps = null;
  let state = initialState;
  const actions = [];
  const dispatch = vi.fn((action) => {
    actions.push(action);
    state = roomReducer(state, action);
  });
  const session = new RoomSession({
    dispatch,
    signaling,
    checkSupport,
    createMediaManager: () => media,
    createMesh: (deps) => {
      meshDeps = deps;
      return mesh;
    },
  });

  return {
    session,
    signaling,
    media,
    mesh,
    actions,
    state: () => state,
    meshDeps: () => meshDeps,
  };
}

afterEach(() => {
  clearToasts();
});

describe('RoomSession.start: успешный вход', () => {
  it('фазы, JOIN_OK и данные ack (FR-4, TDD §4.1.2, §6.3)', async () => {
    const { session, signaling, actions, state } = setup();

    await session.start({ roomId: ROOM_ID, name: 'Алекс' });
    await settle();

    expect(actions.map((action) => action.phase ?? action.type)).toEqual([
      PHASES.CHECKING_ENV,
      PHASES.CONNECTING,
      PHASES.JOINING,
      ACTIONS.JOIN_OK,
      // Захват устройств идёт следом, параллельно mesh (TDD §7.2).
      ACTIONS.LOCAL_MEDIA,
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

describe('RoomSession: mesh и захват устройств идут параллельно (TDD §7.2)', () => {
  it('offer уходит, не дожидаясь диалога разрешений', async () => {
    const { session, media, mesh, actions } = setup();
    const release = media.blockAcquire();

    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    // Захват ещё не завершён, а соединения с участниками из ack уже создаются.
    expect(mesh.connectTo).toHaveBeenCalledExactlyOnceWith([MARIA.id]);
    expect(actions.some(({ type }) => type === ACTIONS.LOCAL_MEDIA)).toBe(false);

    release();
    await settle();

    expect(actions.some(({ type }) => type === ACTIONS.LOCAL_MEDIA)).toBe(true);
  });

  it('после захвата дорожки расходятся по парам и уходит media:state', async () => {
    const { session, mesh, signaling, state } = setup();

    await session.start({ roomId: ROOM_ID, name: 'Алекс' });
    await settle();

    expect(mesh.broadcastTrack.mock.calls).toEqual([
      ['audio', expect.objectContaining({ kind: 'audio' })],
      ['video', expect.objectContaining({ kind: 'video' })],
    ]);
    expect(signaling.sendMediaState).toHaveBeenCalledWith({ audio: true, video: true });
    expect(state().local).toEqual({
      audio: true,
      video: true,
      audioStatus: TRACK_STATUS.OK,
      videoStatus: TRACK_STATUS.OK,
    });
  });

  it('mesh получает sendSignal и iceServers из ack (TDD §6.3)', async () => {
    const { session, signaling, meshDeps } = setup();

    await session.start({ roomId: ROOM_ID, name: 'Алекс' });
    meshDeps().sendSignal(MARIA.id, { type: 'offer', sdp: 'sdp' });

    expect(meshDeps().iceServers).toEqual([{ urls: 'stun:stun.l.google.com:19302' }]);
    expect(signaling.sendSignal).toHaveBeenCalledWith(MARIA.id, { type: 'offer', sdp: 'sdp' });
  });

  it('пары берут текущую локальную дорожку сами', async () => {
    const { session, meshDeps } = setup();

    await session.start({ roomId: ROOM_ID, name: 'Алекс' });
    await settle();

    expect(meshDeps().getLocalTrack('video')).toMatchObject({ kind: 'video' });
  });

  it('отказ в доступе не выбрасывает из комнаты (FR-33, US-12)', async () => {
    const { session, media, state } = setup();
    media.setAcquireResult({
      audio: { status: TRACK_STATUS.DENIED, track: null },
      video: { status: TRACK_STATUS.DENIED, track: null },
    });

    await session.start({ roomId: ROOM_ID, name: 'Алекс' });
    await settle();

    expect(state()).toMatchObject({
      phase: PHASES.IN_ROOM,
      local: {
        audio: false,
        video: false,
        audioStatus: TRACK_STATUS.DENIED,
        videoStatus: TRACK_STATUS.DENIED,
      },
    });
    expect(toastSnapshot().map(({ text }) => text)).toEqual([
      deviceErrorMessage('audio', TRACK_STATUS.DENIED),
      deviceErrorMessage('video', TRACK_STATUS.DENIED),
    ]);
  });

  it('камера занята, микрофон работает: сообщение только о камере (FR-14)', async () => {
    const { session, media, signaling } = setup();
    media.setAcquireResult({
      audio: { status: TRACK_STATUS.OK, track: localTrack('audio') },
      video: { status: TRACK_STATUS.BUSY, track: null },
    });

    await session.start({ roomId: ROOM_ID, name: 'Алекс' });
    await settle();

    expect(toastSnapshot().map(({ text }) => text)).toEqual([
      deviceErrorMessage('video', TRACK_STATUS.BUSY),
    ]);
    expect(signaling.sendMediaState).toHaveBeenCalledWith({ audio: true, video: false });
  });

  it('выход во время диалога разрешений: результат захвата уже никому не нужен', async () => {
    const { session, media, mesh, actions } = setup();
    const release = media.blockAcquire();
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });
    await session.leave();
    const dispatched = actions.length;

    release();
    await settle();

    expect(actions).toHaveLength(dispatched);
    expect(mesh.broadcastTrack).not.toHaveBeenCalled();
  });
});

describe('RoomSession: маршрутизация сигналинга (TDD §7.2, §8.1)', () => {
  it('входящий signal уходит в mesh', async () => {
    const { session, signaling, mesh } = setup();
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    const data = { type: 'offer', sdp: 'offer-sdp' };
    signaling.fire(SERVER_EVENTS.SIGNAL, { from: MARIA.id, data });

    expect(mesh.handleSignal).toHaveBeenCalledWith(MARIA.id, data);
  });

  it('участник вышел: пара закрывается (FR-27, TDD §7.6)', async () => {
    const { session, signaling, mesh } = setup();
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    signaling.fire(SERVER_EVENTS.PARTICIPANT_LEFT, { participantId: MARIA.id });

    expect(mesh.removePeer).toHaveBeenCalledWith(MARIA.id);
  });

  it('PEER_NOT_FOUND: получатель успел выйти — пара закрывается (TDD §8.1)', async () => {
    const { session, signaling, mesh } = setup();
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    signaling.fire(SERVER_EVENTS.SIGNAL_ERROR, {
      to: MARIA.id,
      code: ERROR_CODES.PEER_NOT_FOUND,
    });

    expect(mesh.removePeer).toHaveBeenCalledWith(MARIA.id);
  });

  it('другие ошибки сигналинга пару не закрывают: её пометит таймаут', async () => {
    const { session, signaling, mesh } = setup();
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    signaling.fire(SERVER_EVENTS.SIGNAL_ERROR, { to: MARIA.id, code: ERROR_CODES.INVALID_SIGNAL });
    signaling.fire(SERVER_EVENTS.SIGNAL_ERROR, { to: null, code: ERROR_CODES.PEER_NOT_FOUND });

    expect(mesh.removePeer).not.toHaveBeenCalled();
  });

  it('статус пары попадает в reducer (FR-34, TDD §4.1.6)', async () => {
    const { session, mesh, state } = setup();
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    mesh.emitStatus(MARIA.id, LINK_STATUS.CONNECTING);
    mesh.emitStatus(MARIA.id, LINK_STATUS.FAILED);

    expect(state().links).toEqual({ [MARIA.id]: LINK_STATUS.FAILED });
  });

  it('getStream: своя плитка берёт локальный поток, чужая — поток пары', async () => {
    const { session, media, mesh } = setup();
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    expect(session.getStream(SELF.id)).toBe(media.localStream);
    expect(session.getStream(MARIA.id)).toEqual({ id: `stream-${MARIA.id}` });
    expect(mesh.getStream).toHaveBeenCalledWith(MARIA.id);
  });

  it('до входа потоков нет', () => {
    const { session } = setup();

    expect(session.getStream(MARIA.id)).toBeNull();
  });
});

describe('RoomSession: тумблеры устройств (FR-15, FR-17, US-7, TDD §7.4)', () => {
  /** Вошли в комнату, устройства захвачены: дальше проверяем только сами тумблеры. */
  async function inRoom() {
    const context = setup();
    await context.session.start({ roomId: ROOM_ID, name: 'Алекс' });
    await settle();
    context.signaling.sendMediaState.mockClear();
    context.mesh.broadcastTrack.mockClear();
    return context;
  }

  it('микрофон выключается флагом: нового SDP не нужно', async () => {
    const { session, media, mesh, signaling, state } = await inRoom();

    await session.toggleMic();

    expect(media.setAudioEnabled).toHaveBeenCalledWith(false);
    // Дорожка у пиров та же самая — передаётся тишина (TDD §4.1.4).
    expect(mesh.broadcastTrack).not.toHaveBeenCalled();
    expect(signaling.sendMediaState).toHaveBeenCalledWith({ audio: false, video: true });
    expect(state().local.audio).toBe(false);
  });

  it('камера выключается: пирам уходит null-дорожка и media:state (FR-19)', async () => {
    const { session, media, mesh, signaling, state } = await inRoom();

    await session.toggleCamera();

    expect(media.setVideoEnabled).toHaveBeenCalledWith(false);
    expect(mesh.broadcastTrack).toHaveBeenCalledExactlyOnceWith('video', null);
    expect(signaling.sendMediaState).toHaveBeenCalledWith({ audio: true, video: false });
    expect(state().local.video).toBe(false);
  });

  it('камера включается обратно: новая дорожка расходится по парам', async () => {
    const { session, mesh, signaling, state } = await inRoom();
    await session.toggleCamera();

    await session.toggleCamera();

    expect(mesh.broadcastTrack).toHaveBeenLastCalledWith(
      'video',
      expect.objectContaining({ kind: 'video' }),
    );
    expect(signaling.sendMediaState).toHaveBeenLastCalledWith({ audio: true, video: true });
    expect(state().local.video).toBe(true);
  });

  it('включить не удалось: toast с причиной, тумблер остаётся выключенным (TDD §8.2)', async () => {
    const { session, media, state } = await inRoom();
    await session.toggleCamera();
    media.setVideoEnabled.mockResolvedValueOnce(TRACK_STATUS.BUSY);

    await session.toggleCamera();

    expect(toastSnapshot().map(({ text }) => text)).toEqual([
      deviceErrorMessage('video', TRACK_STATUS.BUSY),
    ]);
    expect(state().local.video).toBe(false);
  });

  it('выключение о причинах не сообщает', async () => {
    const { session } = await inRoom();

    await session.toggleCamera();

    expect(toastSnapshot()).toEqual([]);
  });

  it('двойной клик по тумблеру не запускает второй захват', async () => {
    const { session, media } = await inRoom();

    await Promise.all([session.toggleCamera(), session.toggleCamera()]);

    expect(media.setVideoEnabled).toHaveBeenCalledTimes(1);
  });

  it('до входа в комнату тумблеры ничего не делают', async () => {
    const { session, media } = setup();

    await session.toggleMic();

    expect(media.setAudioEnabled).not.toHaveBeenCalled();
  });

  it('потеря устройства: toast и media:state (FR-20, TDD §8.2)', async () => {
    const { media, mesh, signaling, state } = await inRoom();

    media.emitDeviceLost('video');

    expect(mesh.broadcastTrack).toHaveBeenCalledWith('video', null);
    expect(toastSnapshot().map(({ text }) => text)).toEqual([DEVICE_LOST_MESSAGE]);
    expect(signaling.sendMediaState).toHaveBeenCalledWith({ audio: true, video: false });
    expect(state().local.video).toBe(false);
  });
});

describe('RoomSession: освобождение mesh и устройств (TDD §7.6)', () => {
  it('выход закрывает соединения и останавливает дорожки (US-10)', async () => {
    const { session, media, mesh } = setup();
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    await session.leave();

    expect(mesh.closeAll).toHaveBeenCalledOnce();
    expect(media.dispose).toHaveBeenCalledOnce();
  });

  it('обрыв связи освобождает всё так же (FR-31)', async () => {
    const { session, signaling, media, mesh } = setup();
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    signaling.fire(SIGNALING_EVENTS.DISCONNECTED, { reason: 'transport close', byClient: false });

    expect(mesh.closeAll).toHaveBeenCalledOnce();
    expect(media.dispose).toHaveBeenCalledOnce();
  });

  it('destroy закрывает соединения и останавливает дорожки', async () => {
    const { session, media, mesh } = setup();
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    session.destroy();

    expect(mesh.closeAll).toHaveBeenCalledOnce();
    expect(media.dispose).toHaveBeenCalledOnce();
  });

  it('после выхода потоков и тумблеров нет', async () => {
    const { session, media } = setup();
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });
    await session.leave();
    media.setVideoEnabled.mockClear();

    await session.toggleCamera();

    expect(session.getStream(MARIA.id)).toBeNull();
    expect(media.setVideoEnabled).not.toHaveBeenCalled();
  });

  it('«Войти заново» после обрыва поднимает mesh заново', async () => {
    const { session, signaling, mesh } = setup();
    await session.start({ roomId: ROOM_ID, name: 'Алекс' });
    signaling.fire(SIGNALING_EVENTS.DISCONNECTED, { reason: 'ping timeout', byClient: false });
    mesh.connectTo.mockClear();

    await session.start({ roomId: ROOM_ID, name: 'Алекс' });

    expect(mesh.connectTo).toHaveBeenCalledExactlyOnceWith([MARIA.id]);
  });
});
