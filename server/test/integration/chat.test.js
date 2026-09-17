// Чат и история на настоящем сервере (TDD §11.3): I-4.
import { CLIENT_EVENTS, SERVER_EVENTS } from '@vcr/shared';
import { describe, expect, it } from 'vitest';
import {
  connectAndJoin,
  flushEvents,
  payloadsOf,
  request,
  startTestServer,
  waitForEvent,
} from './harness.js';

const ROOM_ID = 'V1StGXR8_Z';

/** Цель доставки сообщения чата в LAN (TDD §9.1); на localhost запас на порядки. */
const CHAT_DELIVERY_MS = 300;

const userMessage = (author, text) => ({
  id: expect.any(String),
  type: 'user',
  authorId: author.id,
  authorName: author.ack.self.name,
  text,
  ts: expect.any(Number),
});

const systemMessage = (event, subjectName) => ({
  id: expect.any(String),
  type: 'system',
  event,
  subjectName,
  ts: expect.any(Number),
});

describe('I-4: чат и история', () => {
  it('сообщение получают все участники, включая автора, с тем же id, что в ack', async () => {
    const server = await startTestServer();
    const maria = await connectAndJoin(server, ROOM_ID, 'Мария');
    const alex = await connectAndJoin(server, ROOM_ID, 'Алекс');
    // Текст хранится как есть: HTML не экранируется и не вырезается, клиент выводит его текстом.
    const text = 'Всем привет <b>!</b>\nвторая строка';

    const sentAt = Date.now();
    const deliveredToMaria = waitForEvent(maria.client, SERVER_EVENTS.CHAT_MESSAGE);
    const ack = await request(alex.client, CLIENT_EVENTS.CHAT_SEND, { text });
    const { message } = await deliveredToMaria;
    const receivedAt = Date.now();
    await flushEvents(maria.client, alex.client);

    expect(ack).toEqual({ ok: true, message: userMessage(alex, text) });
    expect(message).toEqual(ack.message);
    expect(message.ts).toBeGreaterThanOrEqual(sentAt);
    expect(message.ts).toBeLessThanOrEqual(receivedAt);
    expect(receivedAt - sentAt).toBeLessThan(CHAT_DELIVERY_MS);
    for (const { client } of [maria, alex]) {
      const messages = payloadsOf(client, SERVER_EVENTS.CHAT_MESSAGE).map((p) => p.message);
      expect(messages.filter((m) => m.type === 'user')).toEqual([ack.message]);
    }
  });

  it('сообщения разных авторов приходят всем в порядке отправки', async () => {
    const server = await startTestServer();
    const maria = await connectAndJoin(server, ROOM_ID, 'Мария');
    const alex = await connectAndJoin(server, ROOM_ID, 'Алекс');
    await flushEvents(maria.client);

    await request(maria.client, CLIENT_EVENTS.CHAT_SEND, { text: 'раз' });
    await request(alex.client, CLIENT_EVENTS.CHAT_SEND, { text: 'два' });
    await request(maria.client, CLIENT_EVENTS.CHAT_SEND, { text: 'три' });
    await flushEvents(maria.client, alex.client);

    for (const { client } of [maria, alex]) {
      const texts = payloadsOf(client, SERVER_EVENTS.CHAT_MESSAGE)
        .map((payload) => payload.message)
        .filter((message) => message.type === 'user')
        .map((message) => `${message.authorName}: ${message.text}`);
      expect(texts).toEqual(['Мария: раз', 'Алекс: два', 'Мария: три']);
    }
  });

  it('вошедший позже получает в ack историю: сообщения и системные события по порядку', async () => {
    const server = await startTestServer();
    const maria = await connectAndJoin(server, ROOM_ID, 'Мария');
    const alex = await connectAndJoin(server, ROOM_ID, 'Алекс');
    await request(alex.client, CLIENT_EVENTS.CHAT_SEND, { text: 'Привет' });
    const olga = await connectAndJoin(server, ROOM_ID, 'Ольга');
    await request(olga.client, CLIENT_EVENTS.CHAT_SEND, { text: 'Я ненадолго' });
    await request(olga.client, CLIENT_EVENTS.ROOM_LEAVE);
    await request(maria.client, CLIENT_EVENTS.CHAT_SEND, { text: '  Пока!  ' });

    const ivan = await connectAndJoin(server, ROOM_ID, 'Иван');

    expect(ivan.ack.messages).toEqual([
      systemMessage('joined', 'Мария'),
      systemMessage('joined', 'Алекс'),
      userMessage(alex, 'Привет'),
      systemMessage('joined', 'Ольга'),
      userMessage(olga, 'Я ненадолго'),
      systemMessage('left', 'Ольга'),
      userMessage(maria, 'Пока!'),
    ]);
    const timestamps = ivan.ack.messages.map((message) => message.ts);
    expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
  });

  it('история ограничена CHAT_HISTORY_LIMIT: вошедший позже получает последние сообщения', async () => {
    const server = await startTestServer({ CHAT_HISTORY_LIMIT: '3' });
    const maria = await connectAndJoin(server, ROOM_ID, 'Мария');
    const alex = await connectAndJoin(server, ROOM_ID, 'Алекс');
    await request(maria.client, CLIENT_EVENTS.CHAT_SEND, { text: 'раз' });
    await request(alex.client, CLIENT_EVENTS.CHAT_SEND, { text: 'два' });
    await request(alex.client, CLIENT_EVENTS.CHAT_SEND, { text: 'три' });

    const olga = await connectAndJoin(server, ROOM_ID, 'Ольга');

    // Пять сообщений при лимите 3: системные о входе Марии и Алекса вытеснены, а начало буфера
    // приходится на его середину — порядок от старых к новым всё равно сохраняется.
    expect(olga.ack.messages).toEqual([
      userMessage(maria, 'раз'),
      userMessage(alex, 'два'),
      userMessage(alex, 'три'),
    ]);
  });
});
