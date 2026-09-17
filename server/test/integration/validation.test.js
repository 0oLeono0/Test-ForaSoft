// Проверка входных данных и доступа к событиям на настоящем сервере (TDD §8.1, §10.1, §11.3): I-5.
import {
  CLIENT_EVENTS,
  ERROR_CODES,
  ERROR_MESSAGES,
  MESSAGE_MAX_LENGTH,
  NAME_MAX_LENGTH,
} from '@vcr/shared';
import { describe, expect, it } from 'vitest';
import {
  clearReceivedEvents,
  connectAndJoin,
  connectClient,
  flushEvents,
  joinAs,
  receivedEvents,
  request,
  startTestServer,
} from './harness.js';

const ROOM_ID = 'V1StGXR8_Z';

/** Ack с ошибкой и текстом для UI из TDD §8.1. */
const errorAck = (code) => ({ ok: false, error: { code, message: ERROR_MESSAGES[code] } });

describe('I-5: невалидные данные при входе', () => {
  it.each([
    ['HTML', '<b>'],
    [`${NAME_MAX_LENGTH + 1} символ`, 'а'.repeat(NAME_MAX_LENGTH + 1)],
    ['пустое', ''],
    ['из пробелов', '   '],
    ['без букв и цифр', '...'],
  ])('имя (%s) — INVALID_NAME, комната не создаётся', async (_, name) => {
    const server = await startTestServer();
    const client = await connectClient(server);

    const ack = await request(client, CLIENT_EVENTS.ROOM_JOIN, { roomId: ROOM_ID, name });

    expect(ack).toEqual(errorAck(ERROR_CODES.INVALID_NAME));
    expect(server.roomManager.stats()).toEqual({ rooms: 0, participants: 0 });
  });

  it.each([
    ['путь', '../x'],
    ['пустой', ''],
    ['длиннее 64 символов', 'a'.repeat(65)],
    ['HTML', '<script>'],
  ])('roomId (%s) — INVALID_ROOM_ID, комната не создаётся', async (_, roomId) => {
    const server = await startTestServer();
    const client = await connectClient(server);

    const ack = await request(client, CLIENT_EVENTS.ROOM_JOIN, { roomId, name: 'Мария' });

    expect(ack).toEqual(errorAck(ERROR_CODES.INVALID_ROOM_ID));
    expect(server.roomManager.stats()).toEqual({ rooms: 0, participants: 0 });
  });

  it('после отказа тот же сокет входит с корректными данными; имя нормализуется на сервере', async () => {
    const server = await startTestServer();
    const client = await connectClient(server);
    await request(client, CLIENT_EVENTS.ROOM_JOIN, { roomId: ROOM_ID, name: '<b>' });

    const ack = await joinAs(client, ROOM_ID, `  Анна   ${'я'.repeat(NAME_MAX_LENGTH - 5)}  `);

    expect(ack.self.name).toBe(`Анна ${'я'.repeat(NAME_MAX_LENGTH - 5)}`);
  });

  it.each([
    ['строка', ['V1StGXR8_Z']],
    ['число', [42]],
    ['null', [null]],
    ['массив', [[ROOM_ID, 'Мария']]],
    ['без payload', []],
    ['поля неверного типа', [{ roomId: ROOM_ID, name: ['Мария'] }]],
  ])('payload room:join не объект нужной формы (%s) — INVALID_PAYLOAD', async (_, args) => {
    const server = await startTestServer();
    const client = await connectClient(server);

    const ack = await request(client, CLIENT_EVENTS.ROOM_JOIN, ...args);

    expect(ack).toEqual(errorAck(ERROR_CODES.INVALID_PAYLOAD));
    expect(server.roomManager.stats()).toEqual({ rooms: 0, participants: 0 });
  });

  it('лишние поля room:join отбрасываются: id и индикаторы медиа не подделать', async () => {
    const server = await startTestServer();
    const client = await connectClient(server);

    const ack = await request(client, CLIENT_EVENTS.ROOM_JOIN, {
      roomId: ROOM_ID,
      name: 'Мария',
      id: 'forged-id',
      audio: true,
      video: true,
      isOwner: true,
    });

    expect(ack.self).toEqual({ id: expect.any(String), name: 'Мария', audio: false, video: false });
    expect(ack.self.id).not.toBe('forged-id');
  });
});

describe('I-5: события без входа в комнату', () => {
  it('chat:send и room:leave — NOT_IN_ROOM; media:state и signal молча игнорируются', async () => {
    const server = await startTestServer();
    const maria = await connectAndJoin(server, ROOM_ID, 'Мария');
    const stranger = await connectClient(server);
    await flushEvents(maria.client);
    clearReceivedEvents(maria.client);

    const chat = await request(stranger, CLIENT_EVENTS.CHAT_SEND, { text: 'Привет' });
    const leave = await request(stranger, CLIENT_EVENTS.ROOM_LEAVE);
    stranger.emit(CLIENT_EVENTS.MEDIA_STATE, { audio: true, video: true });
    stranger.emit(CLIENT_EVENTS.SIGNAL, { to: maria.id, data: { type: 'offer', sdp: 'v=0' } });
    // Ack после media:state и signal: сервер уже обработал их, события по порядку сокета.
    await request(stranger, CLIENT_EVENTS.ROOM_LEAVE);
    await flushEvents(maria.client, stranger);

    expect(chat).toEqual(errorAck(ERROR_CODES.NOT_IN_ROOM));
    expect(leave).toEqual(errorAck(ERROR_CODES.NOT_IN_ROOM));
    expect(receivedEvents(maria.client)).toEqual([]);
    expect(receivedEvents(stranger)).toEqual([]);
    const [participant] = server.roomManager.getRoomOf(maria.id).participants.values();
    expect(participant).toMatchObject({ audio: false, video: false });
    expect(server.roomManager.getRoomOf(maria.id).snapshot().messages).toHaveLength(1);
  });
});

describe('I-5: невалидные сообщения чата', () => {
  it.each([
    ['payload-строка', ERROR_CODES.INVALID_PAYLOAD, ['Привет']],
    ['text не строка', ERROR_CODES.INVALID_PAYLOAD, [{ text: 42 }]],
    ['пустое', ERROR_CODES.MESSAGE_EMPTY, [{ text: '' }]],
    ['из пробелов и переводов строк', ERROR_CODES.MESSAGE_EMPTY, [{ text: ' \n\t \n' }]],
    [
      `${MESSAGE_MAX_LENGTH + 1} символ`,
      ERROR_CODES.MESSAGE_TOO_LONG,
      [{ text: 'я'.repeat(MESSAGE_MAX_LENGTH + 1) }],
    ],
  ])('%s — %s, никто ничего не получает, история не меняется', async (_, code, args) => {
    const server = await startTestServer();
    const maria = await connectAndJoin(server, ROOM_ID, 'Мария');
    const alex = await connectAndJoin(server, ROOM_ID, 'Алекс');
    await flushEvents(maria.client);
    clearReceivedEvents(maria.client, alex.client);

    const ack = await request(alex.client, CLIENT_EVENTS.CHAT_SEND, ...args);
    await flushEvents(maria.client, alex.client);

    expect(ack).toEqual(errorAck(code));
    expect(receivedEvents(maria.client)).toEqual([]);
    expect(receivedEvents(alex.client)).toEqual([]);
    const history = server.roomManager.getRoomOf(maria.id).snapshot().messages;
    expect(history.map((message) => message.type)).toEqual(['system', 'system']);
  });

  it(`сообщение ровно из ${MESSAGE_MAX_LENGTH} символов доставляется: длина считается в code points`, async () => {
    const server = await startTestServer();
    const maria = await connectAndJoin(server, ROOM_ID, 'Мария');
    // Эмодзи — два code unit UTF-16, но один символ.
    const text = '😀'.repeat(MESSAGE_MAX_LENGTH);

    const ack = await request(maria.client, CLIENT_EVENTS.CHAT_SEND, { text });

    expect(ack).toMatchObject({ ok: true, message: { text } });
  });
});
