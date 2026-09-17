import { CLIENT_EVENTS, ERROR_CODES, ERROR_MESSAGES, SERVER_EVENTS } from '@vcr/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestbed } from '../../../test/socketTestbed.js';

const NOW = 1789640012000;
const { CHAT_SEND, ROOM_LEAVE } = CLIENT_EVENTS;
const { CHAT_MESSAGE } = SERVER_EVENTS;
const BELL = String.fromCodePoint(0x07);
const RIGHT_TO_LEFT_OVERRIDE = String.fromCodePoint(0x202e);

function errorAck(code) {
  return { ok: false, error: { code, message: ERROR_MESSAGES[code] } };
}

/** Комната из Марии и Алекса и отдельная комната Петра. */
function roomWithTwo() {
  const testbed = createTestbed();
  const maria = testbed.joinAs('Мария');
  const alex = testbed.joinAs('Алекс');
  const petr = testbed.joinAs('Пётр', 'other-room');
  for (const member of [maria, alex, petr]) member.socket.clearReceived();
  return { ...testbed, maria, alex, petr };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('chat:send: отправка', () => {
  it('ack автору и chat:message всей комнате, включая автора; время и имя ставит сервер', () => {
    vi.useFakeTimers({ now: NOW });
    const { maria, alex, petr } = roomWithTwo();

    const ack = alex.socket.request(CHAT_SEND, { text: 'Всем привет' });

    const message = {
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      type: 'user',
      ts: NOW,
      authorId: alex.id,
      authorName: 'Алекс',
      text: 'Всем привет',
    };
    expect(ack).toEqual({ ok: true, message });
    expect(maria.socket.received).toEqual([
      { event: CHAT_MESSAGE, payload: { message: ack.message } },
    ]);
    expect(alex.socket.received).toEqual([
      { event: CHAT_MESSAGE, payload: { message: ack.message } },
    ]);
    expect(petr.socket.received).toEqual([]);
  });

  it('сообщение сохраняется в истории: вошедший позже видит его в ack', () => {
    const { alex, joinAs } = roomWithTwo();
    const { message } = alex.socket.request(CHAT_SEND, { text: 'до входа Ивана' });

    const { ack } = joinAs('Иван');

    expect(ack.messages).toContainEqual(message);
    expect(ack.messages.at(-1)).toEqual(message);
  });

  it('текст нормализуется: края обрезаны, управляющие и bidi-символы удалены, переводы строк сохранены', () => {
    const { alex } = roomWithTwo();

    const { message } = alex.socket.request(CHAT_SEND, {
      text: `  первая${BELL} строка\nвторая ${RIGHT_TO_LEFT_OVERRIDE}строка \n `,
    });

    expect(message.text).toBe('первая строка\nвторая строка');
  });

  it('HTML не экранируется и не вырезается: это делает вывод текстовым узлом на клиенте', () => {
    const { alex } = roomWithTwo();
    const text = '<img src=x onerror=alert(1)> & "кавычки"';

    expect(alex.socket.request(CHAT_SEND, { text }).message.text).toBe(text);
  });

  it('ровно 1000 символов принимаются', () => {
    const { alex } = roomWithTwo();

    expect(alex.socket.request(CHAT_SEND, { text: 'я'.repeat(1000) }).ok).toBe(true);
  });

  it('комната берётся из socket.data: roomId и автор из payload игнорируются', () => {
    const { maria, alex, petr } = roomWithTwo();

    const ack = alex.socket.request(CHAT_SEND, {
      text: 'привет',
      roomId: 'other-room',
      authorId: maria.id,
      authorName: 'Мария',
    });

    expect(ack.message).toMatchObject({ authorId: alex.id, authorName: 'Алекс' });
    expect(maria.socket.eventsOf(CHAT_MESSAGE)).toHaveLength(1);
    expect(petr.socket.received).toEqual([]);
  });

  it('без ack сообщение всё равно рассылается', () => {
    const { maria, alex } = roomWithTwo();

    alex.socket.send(CHAT_SEND, { text: 'без ack' });

    expect(maria.socket.eventsOf(CHAT_MESSAGE).map(({ message }) => message.text)).toEqual([
      'без ack',
    ]);
  });

  it('сбой рассылки после ack: автор уже получил ok, ошибка в логе', () => {
    const { io, alex, logger } = roomWithTwo();
    vi.spyOn(io, 'to').mockImplementation(() => {
      throw new Error('broadcast failed');
    });

    const ack = alex.socket.request(CHAT_SEND, { text: 'привет' });

    expect(ack.ok).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: CHAT_SEND, participantId: alex.id }),
      'socket handler failed',
    );
  });
});

describe('chat:send: отказы', () => {
  it('не в комнате → NOT_IN_ROOM', () => {
    const { io } = createTestbed();

    expect(io.connect().request(CHAT_SEND, { text: 'привет' })).toEqual(
      errorAck(ERROR_CODES.NOT_IN_ROOM),
    );
  });

  it('после выхода → NOT_IN_ROOM, бывшая комната ничего не получает', () => {
    const { maria, alex } = roomWithTwo();
    alex.socket.request(ROOM_LEAVE);
    maria.socket.clearReceived();

    expect(alex.socket.request(CHAT_SEND, { text: 'привет' })).toEqual(
      errorAck(ERROR_CODES.NOT_IN_ROOM),
    );
    expect(maria.socket.received).toEqual([]);
  });

  it.each([
    ['без payload', []],
    ['null', [null]],
    ['строка', ['привет']],
    ['text не строка', [{ text: 42 }]],
    ['нет text', [{}]],
  ])('%s → INVALID_PAYLOAD', (_, args) => {
    const { alex } = roomWithTwo();

    expect(alex.socket.request(CHAT_SEND, ...args)).toEqual(errorAck(ERROR_CODES.INVALID_PAYLOAD));
  });

  it.each([
    ['пустое', '', ERROR_CODES.MESSAGE_EMPTY],
    ['из пробелов и переводов строк', '  \n\t \n', ERROR_CODES.MESSAGE_EMPTY],
    ['из управляющих символов', `${BELL}${BELL}`, ERROR_CODES.MESSAGE_EMPTY],
    ['1001 символ', 'я'.repeat(1001), ERROR_CODES.MESSAGE_TOO_LONG],
  ])('сообщение %s → %s, ничего не сохраняется и не рассылается', (_, text, code) => {
    const { maria, alex, joinAs } = roomWithTwo();

    expect(alex.socket.request(CHAT_SEND, { text })).toEqual(errorAck(code));
    expect(maria.socket.received).toEqual([]);
    expect(joinAs('Иван').ack.messages.filter((message) => message.type === 'user')).toEqual([]);
  });

  it('6-е сообщение за 5 с → RATE_LIMITED и не рассылается; через секунду снова можно (FR-40)', () => {
    vi.useFakeTimers({ now: NOW });
    const { maria, alex } = roomWithTwo();
    for (let i = 1; i <= 5; i += 1) {
      expect(alex.socket.request(CHAT_SEND, { text: `сообщение ${i}` }).ok).toBe(true);
    }

    expect(alex.socket.request(CHAT_SEND, { text: 'шестое' })).toEqual(
      errorAck(ERROR_CODES.RATE_LIMITED),
    );
    expect(maria.socket.eventsOf(CHAT_MESSAGE)).toHaveLength(5);

    vi.advanceTimersByTime(1_000);
    expect(alex.socket.request(CHAT_SEND, { text: 'шестое' }).ok).toBe(true);
  });

  it('лимит чата свой у каждого участника', () => {
    const { maria, alex } = roomWithTwo();
    for (let i = 0; i < 6; i += 1) alex.socket.request(CHAT_SEND, { text: 'флуд' });

    expect(maria.socket.request(CHAT_SEND, { text: 'привет' }).ok).toBe(true);
  });

  it('пустые сообщения расходуют лимит, payload неверной формы — нет', () => {
    const { alex, maria } = roomWithTwo();
    for (let i = 0; i < 10; i += 1) alex.socket.request(CHAT_SEND, 'junk');
    expect(alex.socket.request(CHAT_SEND, { text: 'ok' }).ok).toBe(true);

    for (let i = 0; i < 5; i += 1) maria.socket.request(CHAT_SEND, { text: '   ' });
    expect(maria.socket.request(CHAT_SEND, { text: 'привет' })).toEqual(
      errorAck(ERROR_CODES.RATE_LIMITED),
    );
  });
});
