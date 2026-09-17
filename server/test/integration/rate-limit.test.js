// Защита от злоупотреблений на настоящем сервере (TDD §10.4, §11.3): I-9 и лимиты остальных
// событий из таблицы §10.4.
import { CLIENT_EVENTS, ERROR_CODES, ERROR_MESSAGES, SERVER_EVENTS } from '@vcr/shared';
import { describe, expect, it } from 'vitest';
import { RATE_LIMITS } from '../../src/socket/rateLimiter.js';
import {
  clearReceivedEvents,
  connectAndJoin,
  connectClient,
  flushEvents,
  joinAs,
  payloadsOf,
  receivedEvents,
  request,
  startTestServer,
  waitForEvent,
} from './harness.js';

const ROOM_ID = 'V1StGXR8_Z';

const OFFER = { type: 'offer', sdp: 'v=0\r\n' };

describe('I-9: лимит сообщений чата', () => {
  it(`${RATE_LIMITS.chat.capacity + 1}-е сообщение подряд — RATE_LIMITED, остальные не доставлены`, async () => {
    const server = await startTestServer();
    const maria = await connectAndJoin(server, ROOM_ID, 'Мария');
    const alex = await connectAndJoin(server, ROOM_ID, 'Алекс');
    await flushEvents(maria.client);
    clearReceivedEvents(maria.client, alex.client);
    const { capacity } = RATE_LIMITS.chat;

    const acks = [];
    for (let index = 0; index <= capacity; index += 1) {
      acks.push(
        await request(alex.client, CLIENT_EVENTS.CHAT_SEND, { text: `сообщение ${index}` }),
      );
    }
    await flushEvents(maria.client);

    expect(acks.slice(0, capacity).every((ack) => ack.ok)).toBe(true);
    expect(acks.at(-1)).toEqual({
      ok: false,
      error: {
        code: ERROR_CODES.RATE_LIMITED,
        message: ERROR_MESSAGES.RATE_LIMITED,
      },
    });
    const texts = payloadsOf(maria.client, SERVER_EVENTS.CHAT_MESSAGE).map(
      ({ message }) => message.text,
    );
    expect(texts).toEqual(Array.from({ length: capacity }, (_, index) => `сообщение ${index}`));
    expect(server.roomManager.getRoomOf(maria.id).snapshot().messages).toHaveLength(capacity + 2);
  });

  it('лимит считается на сокет: другой участник продолжает писать', async () => {
    const server = await startTestServer();
    const maria = await connectAndJoin(server, ROOM_ID, 'Мария');
    const alex = await connectAndJoin(server, ROOM_ID, 'Алекс');
    for (let index = 0; index <= RATE_LIMITS.chat.capacity; index += 1) {
      await request(alex.client, CLIENT_EVENTS.CHAT_SEND, { text: `от Алекса ${index}` });
    }

    const ack = await request(maria.client, CLIENT_EVENTS.CHAT_SEND, { text: 'от Марии' });

    expect(ack).toMatchObject({ ok: true, message: { text: 'от Марии' } });
  });
});

describe('лимит room:join', () => {
  it(`${RATE_LIMITS.join.capacity + 1}-я попытка входа с сокета — RATE_LIMITED; другой сокет входит`, async () => {
    const server = await startTestServer();
    const client = await connectClient(server);
    // Неудачные попытки тоже расходуют токены: иначе подбор имени обходил бы лимит.
    for (let attempt = 0; attempt < RATE_LIMITS.join.capacity; attempt += 1) {
      const ack = await request(client, CLIENT_EVENTS.ROOM_JOIN, { roomId: ROOM_ID, name: '<b>' });
      expect(ack.error.code).toBe(ERROR_CODES.INVALID_NAME);
    }

    const ack = await request(client, CLIENT_EVENTS.ROOM_JOIN, { roomId: ROOM_ID, name: 'Мария' });

    expect(ack.error.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(server.roomManager.stats()).toEqual({ rooms: 0, participants: 0 });
    const other = await connectClient(server);
    await expect(joinAs(other, ROOM_ID, 'Алекс')).resolves.toMatchObject({ ok: true });
  });
});

describe('лимит signal', () => {
  it(`${RATE_LIMITS.signal.capacity + 1}-й сигнал — signal:error RATE_LIMITED, остальные доставлены`, async () => {
    const server = await startTestServer();
    const maria = await connectAndJoin(server, ROOM_ID, 'Мария', { transports: ['websocket'] });
    const alex = await connectAndJoin(server, ROOM_ID, 'Алекс', { transports: ['websocket'] });
    clearReceivedEvents(maria.client, alex.client);
    const { capacity } = RATE_LIMITS.signal;

    const relayed = waitForEvent(
      alex.client,
      SERVER_EVENTS.SIGNAL,
      () => receivedEvents(alex.client).length === capacity,
    );
    const rejected = waitForEvent(maria.client, SERVER_EVENTS.SIGNAL_ERROR);
    for (let index = 0; index <= capacity; index += 1) {
      maria.client.emit(CLIENT_EVENTS.SIGNAL, { to: alex.id, data: OFFER });
    }
    await relayed;

    expect(await rejected).toEqual({ to: alex.id, code: ERROR_CODES.RATE_LIMITED });
    await flushEvents(alex.client);
    expect(receivedEvents(alex.client)).toHaveLength(capacity);
  });
});

describe('лимит media:state', () => {
  it(`${RATE_LIMITS.media.capacity + 1}-е состояние молча игнорируется`, async () => {
    const server = await startTestServer();
    const maria = await connectAndJoin(server, ROOM_ID, 'Мария');
    const alex = await connectAndJoin(server, ROOM_ID, 'Алекс');
    await flushEvents(maria.client, alex.client);
    clearReceivedEvents(maria.client, alex.client);
    const { capacity } = RATE_LIMITS.media;

    const applied = waitForEvent(
      alex.client,
      SERVER_EVENTS.PARTICIPANT_MEDIA,
      () => receivedEvents(alex.client).length === capacity,
    );
    for (let index = 0; index <= capacity; index += 1) {
      maria.client.emit(CLIENT_EVENTS.MEDIA_STATE, { audio: index % 2 === 0, video: true });
    }
    await applied;
    // Сверх лимита ответа нет вообще: событие можно проверить только тем, что оно не пришло.
    await flushEvents(maria.client, alex.client);

    expect(receivedEvents(alex.client)).toHaveLength(capacity);
    expect(receivedEvents(maria.client)).toEqual([]);
    const lastApplied = { audio: (capacity - 1) % 2 === 0, video: true };
    const ivan = await connectAndJoin(server, ROOM_ID, 'Иван');
    expect(ivan.ack.participants[0]).toMatchObject(lastApplied);
  });
});

describe('размер кадра', () => {
  it('кадр больше maxHttpBufferSize: Socket.io отключает сокет, участник выходит из комнаты', async () => {
    const server = await startTestServer();
    const maria = await connectAndJoin(server, ROOM_ID, 'Мария');
    const alex = await connectAndJoin(server, ROOM_ID, 'Алекс', { transports: ['websocket'] });
    clearReceivedEvents(maria.client);

    const left = waitForEvent(maria.client, SERVER_EVENTS.PARTICIPANT_LEFT);
    alex.client.emit(CLIENT_EVENTS.CHAT_SEND, { text: 'я'.repeat(70 * 1024) });

    expect(await left).toEqual({ participantId: alex.id });
    expect(server.roomManager.stats()).toEqual({ rooms: 1, participants: 1 });
    // Обработчик сообщение не увидел: до проверки длины текста дело не дошло.
    const messages = payloadsOf(maria.client, SERVER_EVENTS.CHAT_MESSAGE);
    expect(messages.filter(({ message }) => message.type === 'user')).toEqual([]);
    expect(server.roomManager.getRoomOf(maria.id).snapshot().messages).toHaveLength(3);
  });
});
