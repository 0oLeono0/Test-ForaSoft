// Вход в комнату на настоящем сервере (TDD §11.3): I-1, I-2, I-3, I-11.
import {
  CLIENT_EVENTS,
  ERROR_CODES,
  MAX_PARTICIPANTS,
  MESSAGE_MAX_LENGTH,
  SERVER_EVENTS,
} from '@vcr/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_STUN_URLS } from '../../src/config.js';
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
} from './harness.js';

const ROOM_ID = 'V1StGXR8_Z';

/** Системное сообщение о входе в том виде, в каком его получают клиенты. */
const joinedMessage = (subjectName) => ({
  id: expect.any(String),
  type: 'system',
  event: 'joined',
  subjectName,
  ts: expect.any(Number),
});

const errorAck = (code) => ({ ok: false, error: { code, message: expect.any(String) } });

/** Участники подряд входят в одну комнату, каждый своим клиентом. */
async function joinInOrder(server, roomId, names) {
  const members = [];
  for (const name of names) members.push(await connectAndJoin(server, roomId, name));
  return members;
}

describe('I-1: два участника входят в одну комнату', () => {
  it('первый получает пустую комнату, второй — первого участника и его системное сообщение', async () => {
    const server = await startTestServer();
    const maria = await connectClient(server);
    const alex = await connectClient(server);

    const ackMaria = await joinAs(maria, ROOM_ID, 'Мария');
    const ackAlex = await joinAs(alex, ROOM_ID, 'Алекс');

    const shared = {
      ok: true,
      iceServers: [{ urls: DEFAULT_STUN_URLS }],
      limits: { messageMaxLength: MESSAGE_MAX_LENGTH },
    };
    expect(ackMaria).toEqual({
      ...shared,
      self: { id: expect.any(String), name: 'Мария', audio: false, video: false },
      participants: [],
      messages: [],
    });
    expect(ackAlex).toEqual({
      ...shared,
      self: { id: expect.any(String), name: 'Алекс', audio: false, video: false },
      participants: [ackMaria.self],
      messages: [joinedMessage('Мария')],
    });
    expect(ackAlex.self.id).not.toBe(ackMaria.self.id);
  });

  it('первый получает participant:joined и системное сообщение, второй о своём входе — ничего', async () => {
    const server = await startTestServer();
    const maria = await connectAndJoin(server, ROOM_ID, 'Мария');
    const alex = await connectClient(server);

    const before = Date.now();
    const ackAlex = await joinAs(alex, ROOM_ID, 'Алекс');
    await flushEvents(maria.client, alex);

    expect(receivedEvents(maria.client)).toEqual([
      { event: SERVER_EVENTS.PARTICIPANT_JOINED, payload: { participant: ackAlex.self } },
      { event: SERVER_EVENTS.CHAT_MESSAGE, payload: { message: joinedMessage('Алекс') } },
    ]);
    const [, { payload }] = receivedEvents(maria.client);
    expect(payload.message.ts).toBeGreaterThanOrEqual(before);
    expect(payload.message.ts).toBeLessThanOrEqual(Date.now());
    expect(receivedEvents(alex)).toEqual([]);
  });

  it('третий получает участников и историю в порядке входа, первые двое — событие о нём', async () => {
    const server = await startTestServer();
    const [maria, alex] = await joinInOrder(server, ROOM_ID, ['Мария', 'Алекс']);
    clearReceivedEvents(maria.client, alex.client);

    const olga = await connectAndJoin(server, ROOM_ID, 'Ольга');
    await flushEvents(maria.client, alex.client);

    expect(olga.ack.participants).toEqual([maria.ack.self, alex.ack.self]);
    expect(olga.ack.messages).toEqual([joinedMessage('Мария'), joinedMessage('Алекс')]);
    for (const { client } of [maria, alex]) {
      expect(receivedEvents(client)).toEqual([
        { event: SERVER_EVENTS.PARTICIPANT_JOINED, payload: { participant: olga.ack.self } },
        { event: SERVER_EVENTS.CHAT_MESSAGE, payload: { message: joinedMessage('Ольга') } },
      ]);
    }
  });
});

describe('I-2: пятый участник', () => {
  it('получает ROOM_FULL, а участники комнаты и он сам — ни одного события', async () => {
    const server = await startTestServer();
    const members = await joinInOrder(server, ROOM_ID, ['Мария', 'Алекс', 'Ольга', 'Иван']);
    const memberClients = members.map((member) => member.client);
    const petr = await connectClient(server);
    await flushEvents(...memberClients);
    clearReceivedEvents(...memberClients);

    const ack = await request(petr, CLIENT_EVENTS.ROOM_JOIN, { roomId: ROOM_ID, name: 'Пётр' });
    await flushEvents(...memberClients, petr);

    expect(ack).toEqual({
      ok: false,
      error: { code: ERROR_CODES.ROOM_FULL, message: 'Комната заполнена' },
    });
    for (const client of [...memberClients, petr]) expect(receivedEvents(client)).toEqual([]);
    expect(server.roomManager.stats()).toEqual({ rooms: 1, participants: MAX_PARTICIPANTS });
    expect(petr.connected).toBe(true);
  });

  it('после выхода одного из участников повторная попытка с того же сокета успешна (FR-8)', async () => {
    const server = await startTestServer();
    const [maria, alex, olga, ivan] = await joinInOrder(server, ROOM_ID, [
      'Мария',
      'Алекс',
      'Ольга',
      'Иван',
    ]);
    const petr = await connectClient(server);
    const rejected = await request(petr, CLIENT_EVENTS.ROOM_JOIN, {
      roomId: ROOM_ID,
      name: 'Пётр',
    });
    expect(rejected).toEqual(errorAck(ERROR_CODES.ROOM_FULL));

    await request(alex.client, CLIENT_EVENTS.ROOM_LEAVE);
    const ack = await joinAs(petr, ROOM_ID, 'Пётр');

    expect(ack.participants).toEqual([maria.ack.self, olga.ack.self, ivan.ack.self]);
    expect(server.roomManager.stats()).toEqual({ rooms: 1, participants: MAX_PARTICIPANTS });
  });
});

describe('I-3: гонка за последний слот', () => {
  const ITERATIONS = 50;
  // Обработка join на сервере от транспорта не зависит. Без handshake через polling повторы идут
  // на порядок быстрее, а запросы претендентов приходят на сервер плотнее друг к другу.
  const WEBSOCKET_ONLY = { transports: ['websocket'] };

  it(`из двух одновременных входов в комнату с тремя участниками успешен ровно один (${ITERATIONS} повторов)`, async () => {
    const server = await startTestServer();

    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const roomId = `race-${iteration}`;
      // Порядок входа здесь не важен: комната заполняется и претенденты подключаются параллельно.
      const [racers] = await Promise.all([
        Promise.all([connectClient(server, WEBSOCKET_ONLY), connectClient(server, WEBSOCKET_ONLY)]),
        ...['Мария', 'Алекс', 'Ольга'].map((name) =>
          connectAndJoin(server, roomId, name, WEBSOCKET_ONLY),
        ),
      ]);

      // Оба room:join уходят до того, как сервер ответил на любой из них.
      const acks = await Promise.all(
        racers.map((client, index) =>
          request(client, CLIENT_EVENTS.ROOM_JOIN, { roomId, name: `Гость ${index + 1}` }),
        ),
      );

      const context = `повтор ${iteration}`;
      const winner = acks.find((ack) => ack.ok);
      const loser = acks.find((ack) => !ack.ok);
      expect(winner, context).toBeDefined();
      expect(loser, context).toEqual(errorAck(ERROR_CODES.ROOM_FULL));
      const room = server.roomManager.rooms.get(roomId);
      expect(room.size, context).toBe(MAX_PARTICIPANTS);
      expect([...room.participants.keys()].at(-1), context).toBe(winner.self.id);
    }

    expect(server.roomManager.stats()).toEqual({
      rooms: ITERATIONS,
      participants: ITERATIONS * MAX_PARTICIPANTS,
    });
  }, 60_000);
});

describe('I-11: повторный room:join с одного сокета', () => {
  it('после входа — ALREADY_IN_ROOM и в ту же, и в другую комнату; слот и события не дублируются', async () => {
    const server = await startTestServer();
    const [maria, alex] = await joinInOrder(server, ROOM_ID, ['Мария', 'Алекс']);
    await flushEvents(maria.client);
    clearReceivedEvents(maria.client, alex.client);

    const sameRoom = await request(alex.client, CLIENT_EVENTS.ROOM_JOIN, {
      roomId: ROOM_ID,
      name: 'Алекс',
    });
    const otherRoom = await request(alex.client, CLIENT_EVENTS.ROOM_JOIN, {
      roomId: 'other-room',
      name: 'Алекс',
    });
    await flushEvents(maria.client, alex.client);

    expect(sameRoom).toEqual(errorAck(ERROR_CODES.ALREADY_IN_ROOM));
    expect(otherRoom).toEqual(errorAck(ERROR_CODES.ALREADY_IN_ROOM));
    expect(server.roomManager.stats()).toEqual({ rooms: 1, participants: 2 });
    expect(receivedEvents(maria.client)).toEqual([]);
    expect(receivedEvents(alex.client)).toEqual([]);
  });

  it('двойной клик: два room:join без ожидания ack — один вход, свободный слот остаётся свободным', async () => {
    const server = await startTestServer();
    const [maria, alex] = await joinInOrder(server, ROOM_ID, ['Мария', 'Алекс']);
    const olga = await connectClient(server);

    const payload = { roomId: ROOM_ID, name: 'Ольга' };
    const [first, second] = await Promise.all([
      request(olga, CLIENT_EVENTS.ROOM_JOIN, payload),
      request(olga, CLIENT_EVENTS.ROOM_JOIN, payload),
    ]);

    // События одного сокета сервер обрабатывает по порядку отправки.
    expect(first).toMatchObject({ ok: true, self: { name: 'Ольга' } });
    expect(second).toEqual(errorAck(ERROR_CODES.ALREADY_IN_ROOM));
    expect(server.roomManager.stats()).toEqual({ rooms: 1, participants: 3 });

    const ivan = await connectAndJoin(server, ROOM_ID, 'Иван');
    expect(ivan.ack.participants).toEqual([maria.ack.self, alex.ack.self, first.self]);
    await flushEvents(maria.client);
    const joined = payloadsOf(maria.client, SERVER_EVENTS.PARTICIPANT_JOINED);
    expect(joined.map(({ participant }) => participant.name)).toEqual(['Алекс', 'Ольга', 'Иван']);
  });
});
