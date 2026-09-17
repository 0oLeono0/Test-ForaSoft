import { CHAT_HISTORY_LIMIT, ERROR_CODES } from '@vcr/shared';
import { describe, expect, it } from 'vitest';
import { CLIENT_ERROR_CODES } from '../utils/mediaErrors.js';
import { ACTIONS, LINK_STATUS, PHASES, initialState, roomReducer } from './roomReducer.js';

const SELF = { id: 'self-1', name: 'Алекс', audio: true, video: true };
const MARIA = { id: 'p-2', name: 'Мария', audio: true, video: false };
const PETR = { id: 'p-3', name: 'Пётр', audio: false, video: true };

function userMessage(id, overrides = {}) {
  return {
    id,
    type: 'user',
    ts: 1789640000000,
    authorId: SELF.id,
    authorName: SELF.name,
    text: `сообщение ${id}`,
    ...overrides,
  };
}

/** Состояние «в комнате»: себя и Марию видно, история из одного сообщения. */
function inRoom() {
  return roomReducer(initialState, {
    type: ACTIONS.JOIN_OK,
    roomId: 'V1StGXR8_Z',
    self: SELF,
    participants: [MARIA],
    messages: [userMessage('m1')],
  });
}

function ids(state) {
  return state.participants.map(({ id }) => id);
}

describe('roomReducer: начальное состояние', () => {
  it('форма имени, пустая комната (TDD §4.1.6)', () => {
    expect(initialState).toEqual({
      phase: PHASES.NAME_FORM,
      error: null,
      roomId: null,
      selfId: null,
      participants: [],
      messages: [],
      local: { audio: false, video: false, audioStatus: null, videoStatus: null },
      links: {},
      audioLocked: false,
    });
  });

  it('заморожено: reducer не меняет состояние на месте', () => {
    expect(Object.isFrozen(initialState)).toBe(true);
    expect(Object.isFrozen(initialState.local)).toBe(true);
  });
});

describe('roomReducer: PHASE', () => {
  it.each([PHASES.CHECKING_ENV, PHASES.CONNECTING, PHASES.JOINING])('переход в %s', (phase) => {
    expect(roomReducer(initialState, { type: ACTIONS.PHASE, phase })).toMatchObject({
      phase,
      error: null,
    });
  });

  it('сбрасывает прошлую ошибку, если новая не передана', () => {
    const failed = roomReducer(initialState, {
      type: ACTIONS.JOIN_FAILED,
      error: ERROR_CODES.ROOM_FULL,
    });

    expect(roomReducer(failed, { type: ACTIONS.PHASE, phase: PHASES.CONNECTING })).toMatchObject({
      phase: PHASES.CONNECTING,
      error: null,
    });
  });

  it('переносит код ошибки на экран проверки окружения', () => {
    const state = roomReducer(initialState, {
      type: ACTIONS.PHASE,
      phase: PHASES.INSECURE_CONTEXT,
      error: CLIENT_ERROR_CODES.INSECURE_CONTEXT,
    });

    expect(state.error).toBe(CLIENT_ERROR_CODES.INSECURE_CONTEXT);
  });
});

describe('roomReducer: JOIN_OK', () => {
  it('открывает комнату: себя добавляет последним, в порядке входа (FR-26)', () => {
    const state = inRoom();

    expect(state.phase).toBe(PHASES.IN_ROOM);
    expect(state.error).toBeNull();
    expect(state.roomId).toBe('V1StGXR8_Z');
    expect(state.selfId).toBe(SELF.id);
    expect(state.participants).toEqual([MARIA, SELF]);
    expect(state.messages).toEqual([userMessage('m1')]);
  });

  it('первый участник видит только себя и пустую историю (FR-5)', () => {
    const state = roomReducer(initialState, {
      type: ACTIONS.JOIN_OK,
      roomId: 'V1StGXR8_Z',
      self: SELF,
      participants: [],
      messages: [],
    });

    expect(state.participants).toEqual([SELF]);
    expect(state.messages).toEqual([]);
  });

  it('лишние поля участника в состояние не попадают (FR-30)', () => {
    const state = roomReducer(initialState, {
      type: ACTIONS.JOIN_OK,
      roomId: 'r',
      self: { ...SELF, socketId: 'socket-1', joinedAt: 1 },
      participants: [{ ...MARIA, socketId: 'socket-2' }],
      messages: [],
    });

    expect(state.participants).toEqual([MARIA, SELF]);
  });

  it('история из ack обрезается до CHAT_HISTORY_LIMIT', () => {
    const messages = Array.from({ length: CHAT_HISTORY_LIMIT + 5 }, (_, n) => userMessage(`m${n}`));
    const state = roomReducer(initialState, {
      type: ACTIONS.JOIN_OK,
      roomId: 'r',
      self: SELF,
      participants: [],
      messages,
    });

    expect(state.messages).toHaveLength(CHAT_HISTORY_LIMIT);
    expect(state.messages.at(0).id).toBe('m5');
    expect(state.messages.at(-1).id).toBe(`m${CHAT_HISTORY_LIMIT + 4}`);
  });
});

describe('roomReducer: JOIN_FAILED', () => {
  it.each([
    [ERROR_CODES.ROOM_FULL, PHASES.ROOM_FULL],
    [ERROR_CODES.INVALID_NAME, PHASES.NAME_FORM],
    [CLIENT_ERROR_CODES.SERVER_UNAVAILABLE, PHASES.SERVER_UNAVAILABLE],
    [CLIENT_ERROR_CODES.INSECURE_CONTEXT, PHASES.INSECURE_CONTEXT],
    [CLIENT_ERROR_CODES.WEBRTC_UNSUPPORTED, PHASES.UNSUPPORTED],
    [ERROR_CODES.INVALID_ROOM_ID, PHASES.JOIN_ERROR],
    [ERROR_CODES.INVALID_PAYLOAD, PHASES.JOIN_ERROR],
    [ERROR_CODES.INTERNAL_ERROR, PHASES.JOIN_ERROR],
    [ERROR_CODES.RATE_LIMITED, PHASES.JOIN_ERROR],
  ])('%s — фаза %s', (error, phase) => {
    const state = roomReducer(
      { ...initialState, phase: PHASES.JOINING },
      { type: ACTIONS.JOIN_FAILED, error },
    );

    expect(state).toMatchObject({ phase, error });
  });
});

describe('roomReducer: участники', () => {
  it('PARTICIPANT_JOINED добавляет в конец списка', () => {
    const state = roomReducer(inRoom(), { type: ACTIONS.PARTICIPANT_JOINED, participant: PETR });

    expect(ids(state)).toEqual([MARIA.id, SELF.id, PETR.id]);
  });

  it('PARTICIPANT_JOINED с уже известным id ничего не меняет', () => {
    const before = inRoom();
    const state = roomReducer(before, { type: ACTIONS.PARTICIPANT_JOINED, participant: MARIA });

    expect(state).toBe(before);
  });

  it('PARTICIPANT_LEFT удаляет участника и статус соединения с ним', () => {
    const before = roomReducer(inRoom(), {
      type: ACTIONS.LINK_STATUS,
      peerId: MARIA.id,
      status: LINK_STATUS.CONNECTED,
    });

    const state = roomReducer(before, { type: ACTIONS.PARTICIPANT_LEFT, participantId: MARIA.id });

    expect(ids(state)).toEqual([SELF.id]);
    expect(state.links).toEqual({});
  });

  it('PARTICIPANT_LEFT про неизвестного участника ничего не меняет', () => {
    const before = inRoom();
    const state = roomReducer(before, { type: ACTIONS.PARTICIPANT_LEFT, participantId: 'p-404' });

    expect(state).toBe(before);
  });

  it('PARTICIPANT_MEDIA меняет индикаторы только этого участника (FR-15, FR-16)', () => {
    const state = roomReducer(inRoom(), {
      type: ACTIONS.PARTICIPANT_MEDIA,
      participantId: MARIA.id,
      audio: false,
      video: true,
    });

    expect(state.participants).toEqual([{ ...MARIA, audio: false, video: true }, SELF]);
  });

  it('PARTICIPANT_MEDIA про неизвестного участника ничего не меняет', () => {
    const before = inRoom();
    const state = roomReducer(before, {
      type: ACTIONS.PARTICIPANT_MEDIA,
      participantId: 'p-404',
      audio: false,
      video: false,
    });

    expect(state).toBe(before);
  });

  it('одинаковые имена — разные участники (FR-30)', () => {
    const twin = { ...MARIA, id: 'p-9' };
    const state = roomReducer(inRoom(), { type: ACTIONS.PARTICIPANT_JOINED, participant: twin });

    expect(ids(state)).toEqual([MARIA.id, SELF.id, twin.id]);
    expect(state.participants.at(-1).name).toBe(MARIA.name);
  });
});

describe('roomReducer: CHAT_MESSAGE', () => {
  it('добавляет сообщение в конец ленты', () => {
    const state = roomReducer(inRoom(), { type: ACTIONS.CHAT_MESSAGE, message: userMessage('m2') });

    expect(state.messages.map(({ id }) => id)).toEqual(['m1', 'm2']);
  });

  it('дубликат по id (ack и broadcast своего сообщения) ленту не удваивает', () => {
    const before = roomReducer(inRoom(), {
      type: ACTIONS.CHAT_MESSAGE,
      message: userMessage('m2'),
    });
    const state = roomReducer(before, {
      type: ACTIONS.CHAT_MESSAGE,
      message: userMessage('m2', { text: 'другой текст' }),
    });

    expect(state).toBe(before);
  });

  it('системные сообщения хранятся вместе с пользовательскими (FR-25)', () => {
    const system = {
      id: 's1',
      type: 'system',
      ts: 1789640001000,
      event: 'joined',
      subjectName: 'Пётр',
    };
    const state = roomReducer(inRoom(), { type: ACTIONS.CHAT_MESSAGE, message: system });

    expect(state.messages.at(-1)).toEqual(system);
  });

  it('лента не длиннее CHAT_HISTORY_LIMIT: вытесняется самое старое', () => {
    let state = inRoom();
    for (let n = 0; n < CHAT_HISTORY_LIMIT; n += 1) {
      state = roomReducer(state, { type: ACTIONS.CHAT_MESSAGE, message: userMessage(`n${n}`) });
    }

    expect(state.messages).toHaveLength(CHAT_HISTORY_LIMIT);
    expect(state.messages.at(0).id).toBe('n0');
    expect(state.messages.at(-1).id).toBe(`n${CHAT_HISTORY_LIMIT - 1}`);
  });
});

describe('roomReducer: медиа и соединения', () => {
  it('LOCAL_MEDIA дополняет состояние своих устройств, не затирая остальное', () => {
    const withAudio = roomReducer(inRoom(), {
      type: ACTIONS.LOCAL_MEDIA,
      local: { audio: true, audioStatus: 'ok' },
    });
    const state = roomReducer(withAudio, {
      type: ACTIONS.LOCAL_MEDIA,
      local: { video: false, videoStatus: 'DENIED' },
    });

    expect(state.local).toEqual({
      audio: true,
      video: false,
      audioStatus: 'ok',
      videoStatus: 'DENIED',
    });
  });

  it('LINK_STATUS хранит статус по участнику', () => {
    const connecting = roomReducer(inRoom(), {
      type: ACTIONS.LINK_STATUS,
      peerId: MARIA.id,
      status: LINK_STATUS.CONNECTING,
    });
    const state = roomReducer(connecting, {
      type: ACTIONS.LINK_STATUS,
      peerId: MARIA.id,
      status: LINK_STATUS.FAILED,
    });

    expect(state.links).toEqual({ [MARIA.id]: LINK_STATUS.FAILED });
  });

  it('AUDIO_LOCKED включает и снимает баннер «Включить звук» (FR-37)', () => {
    const locked = roomReducer(inRoom(), { type: ACTIONS.AUDIO_LOCKED, locked: true });
    expect(locked.audioLocked).toBe(true);

    const unlocked = roomReducer(locked, { type: ACTIONS.AUDIO_LOCKED, locked: false });
    expect(unlocked.audioLocked).toBe(false);
  });
});

describe('roomReducer: выход и обрыв', () => {
  it('CONNECTION_LOST очищает комнату, оставляя roomId для повторного входа (FR-31)', () => {
    const before = roomReducer(inRoom(), {
      type: ACTIONS.LINK_STATUS,
      peerId: MARIA.id,
      status: LINK_STATUS.CONNECTED,
    });

    const state = roomReducer(before, { type: ACTIONS.CONNECTION_LOST });

    expect(state).toEqual({
      ...initialState,
      phase: PHASES.CONNECTION_LOST,
      error: CLIENT_ERROR_CODES.CONNECTION_LOST,
      roomId: 'V1StGXR8_Z',
    });
  });

  it('LEFT очищает комнату без ошибки (US-10)', () => {
    const state = roomReducer(inRoom(), { type: ACTIONS.LEFT });

    expect(state).toEqual({ ...initialState, phase: PHASES.LEFT, roomId: 'V1StGXR8_Z' });
  });
});

describe('roomReducer: неизвестное действие', () => {
  it.each([{ type: 'CHAT_MESSAGES' }, { type: undefined }, {}])(
    'выбрасывает ошибку на %o',
    (action) => {
      expect(() => roomReducer(initialState, action)).toThrow(/Неизвестное действие/);
    },
  );
});
