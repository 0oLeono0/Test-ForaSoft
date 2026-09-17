import {
  CLIENT_EVENTS,
  ERROR_CODES,
  ERROR_MESSAGES,
  MAX_PARTICIPANTS,
  MESSAGE_MAX_LENGTH,
  SERVER_EVENTS,
} from '@vcr/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ICE_SERVERS, createTestbed } from '../../../test/socketTestbed.js';

const ROOM_ID = 'V1StGXR8_Z';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const { ROOM_JOIN, ROOM_LEAVE } = CLIENT_EVENTS;
const { PARTICIPANT_JOINED, PARTICIPANT_LEFT, CHAT_MESSAGE } = SERVER_EVENTS;

function errorAck(code) {
  return { ok: false, error: { code, message: ERROR_MESSAGES[code] } };
}

function systemMessage(event, subjectName) {
  return { id: expect.any(String), type: 'system', event, subjectName, ts: expect.any(Number) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('room:join: успешный вход', () => {
  it('первый участник создаёт комнату и получает пустой снимок, iceServers и лимиты', () => {
    const { io, roomManager } = createTestbed();
    const socket = io.connect();

    const ack = socket.request(ROOM_JOIN, { roomId: ROOM_ID, name: 'Мария' });

    expect(ack).toEqual({
      ok: true,
      self: { id: expect.stringMatching(UUID), name: 'Мария', audio: false, video: false },
      participants: [],
      messages: [],
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      limits: { messageMaxLength: MESSAGE_MAX_LENGTH },
    });
    expect(ack.iceServers).toEqual(ICE_SERVERS);
    expect(socket.data).toEqual({ participantId: ack.self.id, roomId: ROOM_ID });
    expect(socket.rooms).toEqual(new Set([socket.id, ROOM_ID]));
    expect(roomManager.stats()).toEqual({ rooms: 1, participants: 1 });
    expect(socket.received).toEqual([]);
  });

  it('второй участник видит первого и историю; первый получает participant:joined и системное сообщение', () => {
    const { io, joinAs } = createTestbed();
    const maria = joinAs('Мария');
    maria.socket.clearReceived();
    const alex = io.connect();

    const ack = alex.request(ROOM_JOIN, { roomId: ROOM_ID, name: 'Алекс' });

    expect(ack.participants).toEqual([maria.ack.self]);
    // Своё «присоединилась» Мария не получала, но оно в истории для тех, кто войдёт позже.
    expect(ack.messages).toEqual([systemMessage('joined', 'Мария')]);
    expect(maria.socket.received).toEqual([
      { event: PARTICIPANT_JOINED, payload: { participant: ack.self } },
      { event: CHAT_MESSAGE, payload: { message: systemMessage('joined', 'Алекс') } },
    ]);
    expect(alex.received).toEqual([]);
  });

  it('снимок: участники в порядке входа без себя, актуальные индикаторы медиа, пользовательские и системные сообщения', () => {
    const { io, roomManager, joinAs } = createTestbed();
    const maria = joinAs('Мария');
    const alex = joinAs('Алекс');
    roomManager.setMediaState(maria.id, { audio: true, video: false });
    roomManager.addChatMessage(maria.id, 'Всем привет <b>!</b>');

    const ack = io.connect().request(ROOM_JOIN, { roomId: ROOM_ID, name: 'Пётр' });

    expect(ack.participants).toEqual([
      { id: maria.id, name: 'Мария', audio: true, video: false },
      { id: alex.id, name: 'Алекс', audio: false, video: false },
    ]);
    expect(ack.messages.map((message) => message.subjectName ?? message.text)).toEqual([
      'Мария',
      'Алекс',
      'Всем привет <b>!</b>',
    ]);
    expect(ack.messages.some((message) => message.subjectName === 'Пётр')).toBe(false);
  });

  it('имя нормализуется так же, как на клиенте', () => {
    const { io } = createTestbed();

    const ack = io.connect().request(ROOM_JOIN, { roomId: ROOM_ID, name: '  Алекс   Иванов ' });

    expect(ack.self.name).toBe('Алекс Иванов');
  });

  it('одинаковые имена — разные участники с разными id (FR-30)', () => {
    const { joinAs, roomManager } = createTestbed();

    const first = joinAs('Алекс');
    const second = joinAs('Алекс');

    expect(second.id).not.toBe(first.id);
    expect(second.ack.participants).toEqual([first.ack.self]);
    expect(roomManager.stats().participants).toBe(2);
  });

  it('лишние поля payload игнорируются, в ack только поля ParticipantDTO', () => {
    const { io } = createTestbed();

    const ack = io
      .connect()
      .request(ROOM_JOIN, { roomId: ROOM_ID, name: 'Мария', id: 'fake', isOwner: true });

    expect(ack.ok).toBe(true);
    expect(Object.keys(ack.self).sort()).toEqual(['audio', 'id', 'name', 'video']);
    expect(ack.self.id).not.toBe('fake');
  });

  it('разные комнаты изолированы', () => {
    const { joinAs } = createTestbed();
    const maria = joinAs('Мария', 'room-a');
    maria.socket.clearReceived();

    const petr = joinAs('Пётр', 'room-b');

    expect(petr.ack.participants).toEqual([]);
    expect(petr.ack.messages).toEqual([]);
    expect(maria.socket.received).toEqual([]);
  });

  it('без ack вход всё равно выполняется', () => {
    const { io, roomManager, joinAs } = createTestbed();
    const maria = joinAs('Мария');
    const socket = io.connect();

    expect(() => socket.send(ROOM_JOIN, { roomId: ROOM_ID, name: 'Алекс' })).not.toThrow();

    expect(socket.data.participantId).toEqual(expect.stringMatching(UUID));
    expect(roomManager.stats().participants).toBe(2);
    expect(maria.socket.eventsOf(PARTICIPANT_JOINED)).toHaveLength(1);
  });
});

describe('room:join: лимит участников', () => {
  it(`${MAX_PARTICIPANTS + 1}-й получает ROOM_FULL, остальные ничего не получают`, () => {
    const { io, roomManager, joinAs } = createTestbed();
    const members = ['u1', 'u2', 'u3', 'u4'].map((name) => joinAs(name));
    for (const member of members) member.socket.clearReceived();
    const fifth = io.connect();

    const ack = fifth.request(ROOM_JOIN, { roomId: ROOM_ID, name: 'Пётр' });

    expect(ack).toEqual(errorAck(ERROR_CODES.ROOM_FULL));
    expect(ack.error.message).toBe('Комната заполнена');
    expect(fifth.data).toEqual({ participantId: null, roomId: null });
    expect(fifth.rooms).toEqual(new Set([fifth.id]));
    expect(roomManager.stats()).toEqual({ rooms: 1, participants: 4 });
    for (const member of members) expect(member.socket.received).toEqual([]);
  });

  it('после выхода одного участника повторная попытка того же сокета успешна (FR-8)', () => {
    const { io, joinAs } = createTestbed();
    const members = ['u1', 'u2', 'u3', 'u4'].map((name) => joinAs(name));
    const fifth = io.connect();
    expect(fifth.request(ROOM_JOIN, { roomId: ROOM_ID, name: 'Пётр' }).ok).toBe(false);

    members[1].socket.request(ROOM_LEAVE);

    expect(fifth.request(ROOM_JOIN, { roomId: ROOM_ID, name: 'Пётр' }).ok).toBe(true);
  });
});

describe('room:join: отказы', () => {
  it.each([
    ['без payload', []],
    ['null', [null]],
    ['строка', ['V1StGXR8_Z']],
    ['массив', [[ROOM_ID, 'Мария']]],
    ['roomId не строка', [{ roomId: 42, name: 'Мария' }]],
    ['нет имени', [{ roomId: ROOM_ID }]],
  ])('%s → INVALID_PAYLOAD', (_, args) => {
    const { io, roomManager } = createTestbed();

    expect(io.connect().request(ROOM_JOIN, ...args)).toEqual(errorAck(ERROR_CODES.INVALID_PAYLOAD));
    expect(roomManager.stats().rooms).toBe(0);
  });

  it.each(['', '../x', '<script>', 'a/b', 'room id', 'a'.repeat(65)])(
    'roomId %j → INVALID_ROOM_ID, комната не создаётся',
    (roomId) => {
      const { io, roomManager } = createTestbed();

      expect(io.connect().request(ROOM_JOIN, { roomId, name: 'Мария' })).toEqual(
        errorAck(ERROR_CODES.INVALID_ROOM_ID),
      );
      expect(roomManager.stats().rooms).toBe(0);
    },
  );

  it.each(['', '   ', '<b>', '...', 'Мария😀', 'a'.repeat(31)])(
    'имя %j → INVALID_NAME, комната не создаётся',
    (name) => {
      const { io, roomManager } = createTestbed();

      expect(io.connect().request(ROOM_JOIN, { roomId: ROOM_ID, name })).toEqual(
        errorAck(ERROR_CODES.INVALID_NAME),
      );
      expect(roomManager.stats().rooms).toBe(0);
    },
  );

  it('roomId проверяется раньше имени', () => {
    const { io } = createTestbed();

    expect(io.connect().request(ROOM_JOIN, { roomId: '<x>', name: '<b>' }).error.code).toBe(
      ERROR_CODES.INVALID_ROOM_ID,
    );
  });

  it('повторный вход с того же сокета → ALREADY_IN_ROOM, второй слот не занимается', () => {
    const { roomManager, joinAs } = createTestbed();
    const maria = joinAs('Мария');
    const data = { ...maria.socket.data };

    for (const roomId of [ROOM_ID, 'other-room']) {
      expect(maria.socket.request(ROOM_JOIN, { roomId, name: 'Мария' })).toEqual(
        errorAck(ERROR_CODES.ALREADY_IN_ROOM),
      );
    }

    expect(maria.socket.data).toEqual(data);
    expect(roomManager.stats()).toEqual({ rooms: 1, participants: 1 });
  });

  it('больше 5 попыток за 10 с → RATE_LIMITED раньше проверки имени; через 2 с одна попытка', () => {
    vi.useFakeTimers({ now: 1789640000000 });
    const { io } = createTestbed();
    const socket = io.connect();
    for (let i = 0; i < 5; i += 1) {
      expect(socket.request(ROOM_JOIN, { roomId: ROOM_ID, name: '<b>' }).error.code).toBe(
        ERROR_CODES.INVALID_NAME,
      );
    }

    expect(socket.request(ROOM_JOIN, { roomId: ROOM_ID, name: 'Мария' })).toEqual(
      errorAck(ERROR_CODES.RATE_LIMITED),
    );

    vi.advanceTimersByTime(2_000);
    expect(socket.request(ROOM_JOIN, { roomId: ROOM_ID, name: 'Мария' }).ok).toBe(true);
  });

  it('лимит считается на сокет: другой сокет входит', () => {
    const { io } = createTestbed();
    const flooder = io.connect();
    for (let i = 0; i < 6; i += 1) flooder.request(ROOM_JOIN, { roomId: ROOM_ID, name: '<b>' });

    expect(io.connect().request(ROOM_JOIN, { roomId: ROOM_ID, name: 'Мария' }).ok).toBe(true);
  });

  it('payload неверной формы не расходует лимит', () => {
    const { io } = createTestbed();
    const socket = io.connect();
    for (let i = 0; i < 10; i += 1) socket.request(ROOM_JOIN, 'junk');

    expect(socket.request(ROOM_JOIN, { roomId: ROOM_ID, name: 'Мария' }).ok).toBe(true);
  });
});

describe('room:leave', () => {
  it('остальные получают participant:left и системное «покинул(а)»; сокет выходит из комнаты', () => {
    const { roomManager, joinAs } = createTestbed();
    const maria = joinAs('Мария');
    const alex = joinAs('Алекс');
    maria.socket.clearReceived();

    const ack = alex.socket.request(ROOM_LEAVE, {});

    expect(ack).toEqual({ ok: true });
    expect(maria.socket.received).toEqual([
      { event: PARTICIPANT_LEFT, payload: { participantId: alex.id } },
      { event: CHAT_MESSAGE, payload: { message: systemMessage('left', 'Алекс') } },
    ]);
    expect(alex.socket.received).toEqual([]);
    expect(alex.socket.data).toEqual({ participantId: null, roomId: null });
    expect(alex.socket.rooms).toEqual(new Set([alex.socket.id]));
    expect(roomManager.stats()).toEqual({ rooms: 1, participants: 1 });
  });

  it('системное сообщение о выходе остаётся в истории для тех, кто войдёт позже', () => {
    const { joinAs } = createTestbed();
    joinAs('Мария');
    joinAs('Алекс').socket.request(ROOM_LEAVE);

    const { ack } = joinAs('Пётр');

    expect(ack.messages).toEqual([
      systemMessage('joined', 'Мария'),
      systemMessage('joined', 'Алекс'),
      systemMessage('left', 'Алекс'),
    ]);
  });

  it('выход последнего удаляет комнату; вход по тому же id — новая пустая комната (FR-9)', () => {
    const { roomManager, joinAs } = createTestbed();
    const maria = joinAs('Мария');
    roomManager.addChatMessage(maria.id, 'привет');

    expect(maria.socket.request(ROOM_LEAVE)).toEqual({ ok: true });
    expect(roomManager.stats()).toEqual({ rooms: 0, participants: 0 });

    const { ack } = joinAs('Алекс');
    expect(ack.messages).toEqual([]);
    expect(ack.participants).toEqual([]);
  });

  it('не в комнате → NOT_IN_ROOM', () => {
    const { io } = createTestbed();

    expect(io.connect().request(ROOM_LEAVE, {})).toEqual(errorAck(ERROR_CODES.NOT_IN_ROOM));
  });

  it('повторный выход → NOT_IN_ROOM без повторной рассылки', () => {
    const { joinAs } = createTestbed();
    const maria = joinAs('Мария');
    const alex = joinAs('Алекс');
    alex.socket.request(ROOM_LEAVE);
    maria.socket.clearReceived();

    expect(alex.socket.request(ROOM_LEAVE)).toEqual(errorAck(ERROR_CODES.NOT_IN_ROOM));
    expect(maria.socket.received).toEqual([]);
  });

  it('без ack (pagehide) выход выполняется', () => {
    const { roomManager, joinAs } = createTestbed();
    const maria = joinAs('Мария');
    const alex = joinAs('Алекс');

    alex.socket.send(ROOM_LEAVE);

    expect(roomManager.stats().participants).toBe(1);
    expect(maria.socket.eventsOf(PARTICIPANT_LEFT)).toEqual([{ participantId: alex.id }]);
  });

  it('после выхода тот же сокет может войти снова новым участником', () => {
    const { joinAs } = createTestbed();
    joinAs('Мария');
    const alex = joinAs('Алекс');
    alex.socket.request(ROOM_LEAVE);

    const ack = alex.socket.request(ROOM_JOIN, { roomId: ROOM_ID, name: 'Алекс' });

    expect(ack.ok).toBe(true);
    expect(ack.self.id).not.toBe(alex.id);
  });

  it('выход не сбрасывает лимит входа: цикл вход-выход упирается в RATE_LIMITED', () => {
    const { io } = createTestbed();
    const socket = io.connect();
    for (let i = 0; i < 5; i += 1) {
      expect(socket.request(ROOM_JOIN, { roomId: ROOM_ID, name: 'Мария' }).ok).toBe(true);
      socket.request(ROOM_LEAVE);
    }

    expect(socket.request(ROOM_JOIN, { roomId: ROOM_ID, name: 'Мария' })).toEqual(
      errorAck(ERROR_CODES.RATE_LIMITED),
    );
  });
});

describe('disconnect', () => {
  it('равен выходу: остальные получают participant:left и системное «покинул(а)», слот свободен', () => {
    const { roomManager, joinAs } = createTestbed();
    const maria = joinAs('Мария');
    const alex = joinAs('Алекс');
    maria.socket.clearReceived();

    alex.socket.disconnect('ping timeout');

    expect(maria.socket.received).toEqual([
      { event: PARTICIPANT_LEFT, payload: { participantId: alex.id } },
      { event: CHAT_MESSAGE, payload: { message: systemMessage('left', 'Алекс') } },
    ]);
    expect(roomManager.stats()).toEqual({ rooms: 1, participants: 1 });
  });

  it('после room:leave не дублирует рассылку', () => {
    const { joinAs } = createTestbed();
    const maria = joinAs('Мария');
    const alex = joinAs('Алекс');
    alex.socket.request(ROOM_LEAVE);
    maria.socket.clearReceived();

    alex.socket.disconnect('client namespace disconnect');

    expect(maria.socket.received).toEqual([]);
  });

  it('последний участник — комната удалена, рассылать некому', () => {
    const { io, roomManager, joinAs } = createTestbed();
    const maria = joinAs('Мария');
    const broadcast = vi.spyOn(io, 'to');

    maria.socket.disconnect();

    expect(roomManager.stats()).toEqual({ rooms: 0, participants: 0 });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('сокет вне комнаты — ничего не происходит', () => {
    const { io, logger } = createTestbed();

    expect(() => io.connect().disconnect()).not.toThrow();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('сбрасывает rate limit сокета', () => {
    const { io, rateLimiter } = createTestbed();
    const forget = vi.spyOn(rateLimiter, 'forget');
    const socket = io.connect();
    socket.request(ROOM_JOIN, { roomId: ROOM_ID, name: 'Мария' });

    socket.disconnect();

    expect(forget).toHaveBeenCalledWith(socket.id);
  });

  it('rate limit сбрасывается, даже если выход упал с ошибкой', () => {
    const { rateLimiter, roomManager, logger, joinAs } = createTestbed();
    const forget = vi.spyOn(rateLimiter, 'forget');
    const maria = joinAs('Мария');
    vi.spyOn(roomManager, 'leave').mockImplementation(() => {
      throw new Error('leave failed');
    });

    expect(() => maria.socket.disconnect()).not.toThrow();

    expect(forget).toHaveBeenCalledWith(maria.socket.id);
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

describe('логи', () => {
  it('вход и выход пишутся на info без имени; имя — только на debug', () => {
    const { logger, joinAs } = createTestbed();
    const maria = joinAs('Мария');
    maria.socket.request(ROOM_LEAVE);

    const infoRecords = logger.info.mock.calls.map(([record]) => record);
    expect(infoRecords).toEqual([
      { roomId: ROOM_ID, participantId: maria.id, size: 1 },
      { roomId: ROOM_ID, participantId: maria.id, reason: 'room:leave', roomDeleted: true },
    ]);
    expect(JSON.stringify(infoRecords)).not.toContain('Мария');
    expect(logger.debug).toHaveBeenCalledWith(
      { roomId: ROOM_ID, participantId: maria.id, name: 'Мария' },
      'participant name',
    );
  });
});
