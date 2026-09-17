import { CLIENT_EVENTS, ERROR_CODES, SERVER_EVENTS } from '@vcr/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestbed } from '../../../test/socketTestbed.js';
import { SDP_MAX_LENGTH } from '../validatePayload.js';

const { SIGNAL, ROOM_LEAVE } = CLIENT_EVENTS;
const { SIGNAL_ERROR } = SERVER_EVENTS;
const OFFER = Object.freeze({ type: 'offer', sdp: 'v=0\r\no=- 4611 2 IN IP4 127.0.0.1\r\n' });

/** Комната из Марии, Алекса и Ивана и отдельная комната Петра. */
function roomWithThree() {
  const testbed = createTestbed();
  const maria = testbed.joinAs('Мария');
  const alex = testbed.joinAs('Алекс');
  const ivan = testbed.joinAs('Иван');
  const petr = testbed.joinAs('Пётр', 'other-room');
  for (const member of [maria, alex, ivan, petr]) member.socket.clearReceived();
  return { ...testbed, maria, alex, ivan, petr };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('signal: пересылка', () => {
  it.each([
    ['offer', OFFER],
    ['answer', { type: 'answer', sdp: 'v=0\r\n' }],
    [
      'candidate',
      {
        type: 'candidate',
        candidate: {
          candidate: 'candidate:1 1 udp 2122260223 192.168.1.5 54321 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0,
        },
      },
    ],
    ['end-of-candidates', { type: 'candidate', candidate: null }],
  ])('%s доставляется только получателю с from отправителя', (_, data) => {
    const { maria, alex, ivan, petr } = roomWithThree();

    alex.socket.send(SIGNAL, { to: maria.id, data });

    expect(maria.socket.received).toEqual([{ event: SIGNAL, payload: { from: alex.id, data } }]);
    expect(alex.socket.received).toEqual([]);
    expect(ivan.socket.received).toEqual([]);
    expect(petr.socket.received).toEqual([]);
  });

  it('from из payload игнорируется: его проставляет сервер (I-8)', () => {
    const { maria, alex, ivan } = roomWithThree();

    alex.socket.send(SIGNAL, { to: maria.id, from: ivan.id, data: OFFER });

    expect(maria.socket.eventsOf(SIGNAL)).toEqual([{ from: alex.id, data: OFFER }]);
  });

  it('лишние поля в data отбрасываются', () => {
    const { maria, alex } = roomWithThree();

    alex.socket.send(SIGNAL, { to: maria.id, data: { ...OFFER, from: 'x', html: '<b>' } });

    expect(maria.socket.eventsOf(SIGNAL)).toEqual([{ from: alex.id, data: OFFER }]);
  });

  it('обмен в обе стороны: ответ идёт отправителю offer', () => {
    const { maria, alex } = roomWithThree();

    alex.socket.send(SIGNAL, { to: maria.id, data: OFFER });
    maria.socket.send(SIGNAL, { to: alex.id, data: { type: 'answer', sdp: 'v=0\r\n' } });

    expect(alex.socket.eventsOf(SIGNAL)).toEqual([
      { from: maria.id, data: { type: 'answer', sdp: 'v=0\r\n' } },
    ]);
  });

  it('ack не вызывается: у события нет ответа', () => {
    const { maria, alex } = roomWithThree();
    const ack = vi.fn();

    alex.socket.send(SIGNAL, { to: maria.id, data: OFFER }, ack);
    alex.socket.send(SIGNAL, { to: 'unknown', data: OFFER }, ack);

    expect(ack).not.toHaveBeenCalled();
  });
});

describe('signal: PEER_NOT_FOUND', () => {
  it('получатель из другой комнаты: ошибка отправителю, получатель ничего не получает (I-8)', () => {
    const { alex, petr } = roomWithThree();

    alex.socket.send(SIGNAL, { to: petr.id, data: OFFER });

    expect(alex.socket.received).toEqual([
      { event: SIGNAL_ERROR, payload: { to: petr.id, code: ERROR_CODES.PEER_NOT_FOUND } },
    ]);
    expect(petr.socket.received).toEqual([]);
  });

  it('неизвестный id', () => {
    const { alex } = roomWithThree();

    alex.socket.send(SIGNAL, { to: '00000000-0000-4000-8000-000000000000', data: OFFER });

    expect(alex.socket.eventsOf(SIGNAL_ERROR)).toEqual([
      { to: '00000000-0000-4000-8000-000000000000', code: ERROR_CODES.PEER_NOT_FOUND },
    ]);
  });

  it('сам себе', () => {
    const { alex } = roomWithThree();

    alex.socket.send(SIGNAL, { to: alex.id, data: OFFER });

    expect(alex.socket.received).toEqual([
      { event: SIGNAL_ERROR, payload: { to: alex.id, code: ERROR_CODES.PEER_NOT_FOUND } },
    ]);
  });

  it.each([
    ['вышел через room:leave', (socket) => socket.request(ROOM_LEAVE)],
    ['отключился', (socket) => socket.disconnect()],
  ])('получатель %s во время согласования (TDD §8.3)', (_, leave) => {
    const { maria, alex } = roomWithThree();
    leave(maria.socket);
    alex.socket.clearReceived();

    alex.socket.send(SIGNAL, { to: maria.id, data: { type: 'candidate', candidate: null } });

    expect(alex.socket.eventsOf(SIGNAL_ERROR)).toEqual([
      { to: maria.id, code: ERROR_CODES.PEER_NOT_FOUND },
    ]);
    expect(maria.socket.eventsOf(SIGNAL)).toEqual([]);
  });
});

describe('signal: INVALID_SIGNAL', () => {
  it.each([
    ['нет data', { to: 'peer-id' }],
    ['неизвестный type', { to: 'peer-id', data: { type: 'renegotiate', sdp: 'v=0' } }],
    ['пустой sdp', { to: 'peer-id', data: { type: 'offer', sdp: '' } }],
    [
      'sdp длиннее лимита',
      { to: 'peer-id', data: { type: 'offer', sdp: 'a'.repeat(SDP_MAX_LENGTH + 1) } },
    ],
    ['candidate не объект', { to: 'peer-id', data: { type: 'candidate', candidate: 'x' } }],
  ])('%s → ошибка с to из payload', (_, payload) => {
    const { alex } = roomWithThree();

    alex.socket.send(SIGNAL, payload);

    expect(alex.socket.received).toEqual([
      { event: SIGNAL_ERROR, payload: { to: 'peer-id', code: ERROR_CODES.INVALID_SIGNAL } },
    ]);
  });

  it.each([
    ['без payload', []],
    ['null', [null]],
    ['строка', ['offer']],
    ['to не строка', [{ to: 42, data: OFFER }]],
    ['to длиннее 64 символов', [{ to: 'x'.repeat(65), data: OFFER }]],
  ])('%s → ошибка с to: null', (_, args) => {
    const { alex } = roomWithThree();

    alex.socket.send(SIGNAL, ...args);

    expect(alex.socket.eventsOf(SIGNAL_ERROR)).toEqual([
      { to: null, code: ERROR_CODES.INVALID_SIGNAL },
    ]);
  });

  it('некорректный сигнал не пересылается даже существующему участнику', () => {
    const { maria, alex } = roomWithThree();

    alex.socket.send(SIGNAL, { to: maria.id, data: { type: 'offer' } });

    expect(maria.socket.received).toEqual([]);
    expect(alex.socket.eventsOf(SIGNAL_ERROR)).toEqual([
      { to: maria.id, code: ERROR_CODES.INVALID_SIGNAL },
    ]);
  });
});

describe('signal: вне комнаты и rate limit', () => {
  it('сокет не в комнате — игнорируется без ответа', () => {
    const { io, maria } = roomWithThree();
    const outsider = io.connect();

    outsider.send(SIGNAL, { to: maria.id, data: OFFER });
    outsider.send(SIGNAL, 'junk');

    expect(maria.socket.received).toEqual([]);
    expect(outsider.received).toEqual([]);
  });

  it('после выхода — игнорируется', () => {
    const { maria, alex } = roomWithThree();
    alex.socket.request(ROOM_LEAVE);
    maria.socket.clearReceived();
    alex.socket.clearReceived();

    alex.socket.send(SIGNAL, { to: maria.id, data: OFFER });

    expect(maria.socket.received).toEqual([]);
    expect(alex.socket.received).toEqual([]);
  });

  it('301-й сигнал за 10 с → RATE_LIMITED и не пересылается; запас пополняется', () => {
    vi.useFakeTimers({ now: 1789640000000 });
    const { maria, alex } = roomWithThree();
    const candidate = { type: 'candidate', candidate: null };
    for (let i = 0; i < 300; i += 1) alex.socket.send(SIGNAL, { to: maria.id, data: candidate });

    alex.socket.send(SIGNAL, { to: maria.id, data: candidate });

    expect(maria.socket.eventsOf(SIGNAL)).toHaveLength(300);
    expect(alex.socket.eventsOf(SIGNAL_ERROR)).toEqual([
      { to: maria.id, code: ERROR_CODES.RATE_LIMITED },
    ]);

    vi.advanceTimersByTime(34);
    alex.socket.send(SIGNAL, { to: maria.id, data: candidate });
    expect(maria.socket.eventsOf(SIGNAL)).toHaveLength(301);
  });

  it('лимит считается до поиска получателя: сигналы неизвестному пиру тоже расходуют его', () => {
    const { maria, alex } = roomWithThree();
    for (let i = 0; i < 300; i += 1) alex.socket.send(SIGNAL, { to: 'gone', data: OFFER });
    alex.socket.clearReceived();

    alex.socket.send(SIGNAL, { to: maria.id, data: OFFER });

    expect(alex.socket.eventsOf(SIGNAL_ERROR)).toEqual([
      { to: maria.id, code: ERROR_CODES.RATE_LIMITED },
    ]);
  });

  it('некорректные сигналы лимит не расходуют; лимит у каждого сокета свой', () => {
    const { maria, alex, ivan } = roomWithThree();
    for (let i = 0; i < 300; i += 1) alex.socket.send(SIGNAL, { to: maria.id, data: {} });
    for (let i = 0; i < 301; i += 1) ivan.socket.send(SIGNAL, { to: maria.id, data: OFFER });
    maria.socket.clearReceived();

    alex.socket.send(SIGNAL, { to: maria.id, data: OFFER });

    expect(maria.socket.eventsOf(SIGNAL)).toEqual([{ from: alex.id, data: OFFER }]);
  });
});
