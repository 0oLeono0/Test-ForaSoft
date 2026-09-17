import { CLIENT_EVENTS, ERROR_CODES, ERROR_MESSAGES, SERVER_EVENTS } from '@vcr/shared';
import { describe, expect, it, vi } from 'vitest';
import { createTestbed } from '../../test/socketTestbed.js';

const ROOM_ID = 'V1StGXR8_Z';
const INTERNAL_ERROR_ACK = {
  ok: false,
  error: { code: ERROR_CODES.INTERNAL_ERROR, message: ERROR_MESSAGES.INTERNAL_ERROR },
};

describe('registerHandlers: подключение', () => {
  it('socket.data нового сокета: участника и комнаты нет', () => {
    const { io } = createTestbed();

    expect(io.connect().data).toEqual({ participantId: null, roomId: null });
  });

  it('у каждого сокета своё socket.data', () => {
    const { io, joinAs } = createTestbed();
    const maria = joinAs('Мария');

    expect(io.connect().data).toEqual({ participantId: null, roomId: null });
    expect(maria.socket.data.participantId).toBe(maria.id);
  });
});

describe('registerHandlers: аргументы события', () => {
  it('ack берётся из последнего аргумента, payload — из первого', () => {
    const { io } = createTestbed();

    const ack = io
      .connect()
      .request(CLIENT_EVENTS.ROOM_JOIN, { roomId: ROOM_ID, name: 'Мария' }, 'лишний', 42);

    expect(ack.ok).toBe(true);
  });

  it('только ack без payload → INVALID_PAYLOAD', () => {
    const { io } = createTestbed();

    expect(io.connect().request(CLIENT_EVENTS.ROOM_JOIN)).toEqual({
      ok: false,
      error: { code: ERROR_CODES.INVALID_PAYLOAD, message: ERROR_MESSAGES.INVALID_PAYLOAD },
    });
  });

  it('ack не последним аргументом не вызывается и не считается payload', () => {
    const { io, roomManager } = createTestbed();
    const ack = vi.fn();

    io.connect().send(CLIENT_EVENTS.ROOM_JOIN, ack, { roomId: ROOM_ID, name: 'Мария' });

    expect(ack).not.toHaveBeenCalled();
    expect(roomManager.stats().rooms).toBe(0);
  });
});

describe('registerHandlers: исключения в обработчиках', () => {
  it('исключение → ack INTERNAL_ERROR и запись в лог с контекстом; сокет продолжает работать', () => {
    const { io, roomManager, logger } = createTestbed();
    const error = new Error('join failed');
    const join = vi.spyOn(roomManager, 'join').mockImplementationOnce(() => {
      throw error;
    });
    const socket = io.connect();

    const ack = socket.request(CLIENT_EVENTS.ROOM_JOIN, { roomId: ROOM_ID, name: 'Мария' });

    expect(ack).toEqual(INTERNAL_ERROR_ACK);
    expect(logger.error).toHaveBeenCalledWith(
      {
        err: error,
        event: CLIENT_EVENTS.ROOM_JOIN,
        socketId: socket.id,
        participantId: null,
        roomId: null,
      },
      'socket handler failed',
    );

    join.mockRestore();
    expect(socket.request(CLIENT_EVENTS.ROOM_JOIN, { roomId: ROOM_ID, name: 'Мария' }).ok).toBe(
      true,
    );
  });

  it('исключение без ack только пишется в лог', () => {
    const { io, roomManager, logger } = createTestbed();
    vi.spyOn(roomManager, 'join').mockImplementation(() => {
      throw new Error('join failed');
    });

    expect(() =>
      io.connect().send(CLIENT_EVENTS.ROOM_JOIN, { roomId: ROOM_ID, name: 'Мария' }),
    ).not.toThrow();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('исключение в disconnect пишется в лог с событием disconnect', () => {
    const { roomManager, logger, joinAs } = createTestbed();
    const maria = joinAs('Мария');
    vi.spyOn(roomManager, 'leave').mockImplementation(() => {
      throw new Error('leave failed');
    });

    expect(() => maria.socket.disconnect()).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'disconnect', socketId: maria.socket.id }),
      'socket handler failed',
    );
  });

  it('ошибки одного сокета не мешают другим', () => {
    const { io, roomManager, joinAs } = createTestbed();
    const maria = joinAs('Мария');
    maria.socket.clearReceived();
    vi.spyOn(roomManager, 'join').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    io.connect().request(CLIENT_EVENTS.ROOM_JOIN, { roomId: ROOM_ID, name: 'Пётр' });

    joinAs('Алекс');

    expect(maria.socket.eventsOf(SERVER_EVENTS.PARTICIPANT_JOINED)).toHaveLength(1);
  });
});
