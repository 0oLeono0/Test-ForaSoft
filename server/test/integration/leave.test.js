// Выход, отключение и удаление комнаты на настоящем сервере (TDD §11.3): I-6, I-7.
import { CLIENT_EVENTS, ERROR_CODES, SERVER_EVENTS } from '@vcr/shared';
import { describe, expect, it } from 'vitest';
import {
  clearReceivedEvents,
  connectAndJoin,
  disconnectClient,
  flushEvents,
  joinAs,
  payloadsOf,
  receivedEvents,
  request,
  startTestServer,
  waitForEvent,
} from './harness.js';

const ROOM_ID = 'V1StGXR8_Z';

/** События, которые остаются участникам, когда кто-то выходит (TDD §6.4, §7.6). */
const leftEvents = (participant) => [
  { event: SERVER_EVENTS.PARTICIPANT_LEFT, payload: { participantId: participant.id } },
  {
    event: SERVER_EVENTS.CHAT_MESSAGE,
    payload: {
      message: {
        id: expect.any(String),
        type: 'system',
        event: 'left',
        subjectName: participant.ack.self.name,
        ts: expect.any(Number),
      },
    },
  },
];

/** Трое в одной комнате; журналы событий очищены. */
async function roomOfThree(server) {
  const members = [];
  for (const name of ['Мария', 'Алекс', 'Ольга']) {
    members.push(await connectAndJoin(server, ROOM_ID, name));
  }
  const clients = members.map((member) => member.client);
  await flushEvents(...clients);
  clearReceivedEvents(...clients);
  return members;
}

describe('I-6: room:leave и disconnect', () => {
  it('room:leave: ack ok, остальные получают participant:left и системное сообщение, вышедший — ничего', async () => {
    const server = await startTestServer();
    const [maria, alex, olga] = await roomOfThree(server);

    const ack = await request(alex.client, CLIENT_EVENTS.ROOM_LEAVE);
    await flushEvents(maria.client, alex.client, olga.client);

    expect(ack).toEqual({ ok: true });
    expect(receivedEvents(maria.client)).toEqual(leftEvents(alex));
    expect(receivedEvents(olga.client)).toEqual(leftEvents(alex));
    expect(receivedEvents(alex.client)).toEqual([]);
    expect(alex.client.connected).toBe(true);
    expect(server.roomManager.stats()).toEqual({ rooms: 1, participants: 2 });
  });

  it.each([
    ['disconnect', 'socket.disconnect()', 'client namespace disconnect'],
    ['transport', 'закрытие вкладки', 'transport close'],
  ])(
    'отключение (%s, %s): остальные получают те же события, что при room:leave',
    async (mode, _, reason) => {
      const server = await startTestServer();
      const [maria, alex, olga] = await roomOfThree(server);

      // Цель — не дольше 2 с после закрытия вкладки (TDD §9.1): столько ждёт waitForEvent.
      const left = waitForEvent(maria.client, SERVER_EVENTS.PARTICIPANT_LEFT);
      await expect(disconnectClient(alex.client, mode)).resolves.toBe(reason);
      await left;
      await flushEvents(maria.client, olga.client);

      // Системное сообщение то же «покинул(а) комнату», без «соединение потеряно» (FR-31).
      expect(receivedEvents(maria.client)).toEqual(leftEvents(alex));
      expect(receivedEvents(olga.client)).toEqual(leftEvents(alex));
      expect(server.roomManager.stats()).toEqual({ rooms: 1, participants: 2 });
    },
  );

  it('disconnect после room:leave и повторный room:leave не дублируют события', async () => {
    const server = await startTestServer();
    const [maria, alex] = await roomOfThree(server);

    await request(alex.client, CLIENT_EVENTS.ROOM_LEAVE);
    const second = await request(alex.client, CLIENT_EVENTS.ROOM_LEAVE);
    await disconnectClient(alex.client);
    await flushEvents(maria.client);

    expect(second).toMatchObject({ ok: false, error: { code: ERROR_CODES.NOT_IN_ROOM } });
    expect(receivedEvents(maria.client)).toEqual(leftEvents(alex));
  });

  it('уход со страницы: room:leave без ожидания ack и сразу отключение — один выход', async () => {
    const server = await startTestServer();
    const [maria, alex, olga] = await roomOfThree(server);

    // Как pagehide в браузере (TDD §7.6): best-effort room:leave, затем закрытие соединения.
    alex.client.emit(CLIENT_EVENTS.ROOM_LEAVE);
    await disconnectClient(alex.client, 'transport');
    await flushEvents(maria.client, olga.client);

    expect(receivedEvents(maria.client)).toEqual(leftEvents(alex));
    expect(receivedEvents(olga.client)).toEqual(leftEvents(alex));
  });

  it('несколько выходов подряд: каждый оставшийся получает по паре событий на каждого вышедшего', async () => {
    const server = await startTestServer();
    const [maria, alex, olga] = await roomOfThree(server);

    await request(olga.client, CLIENT_EVENTS.ROOM_LEAVE);
    await disconnectClient(alex.client, 'transport');
    await flushEvents(maria.client);

    expect(receivedEvents(maria.client)).toEqual([...leftEvents(olga), ...leftEvents(alex)]);
    const joined = await connectAndJoin(server, ROOM_ID, 'Иван');
    expect(joined.ack.participants).toEqual([maria.ack.self]);
  });
});

describe('I-7: удаление комнаты', () => {
  it('все вышли — комнаты нет, /healthz это видит; вход по тому же id — пустая комната', async () => {
    const server = await startTestServer();
    const [maria, alex, olga] = await roomOfThree(server);
    await request(alex.client, CLIENT_EVENTS.CHAT_SEND, { text: 'Сообщение до удаления' });
    const healthz = async () => (await fetch(`${server.url}/healthz`)).json();
    expect(await healthz()).toMatchObject({ rooms: 1, participants: 3 });

    await request(maria.client, CLIENT_EVENTS.ROOM_LEAVE);
    await disconnectClient(alex.client, 'disconnect');
    await disconnectClient(olga.client, 'transport');

    expect(server.roomManager.stats()).toEqual({ rooms: 0, participants: 0 });
    expect(await healthz()).toMatchObject({ rooms: 0, participants: 0 });

    // Вышедшая по кнопке Мария входит тем же сокетом: это новый участник в новой комнате (FR-9).
    const ack = await joinAs(maria.client, ROOM_ID, 'Мария');
    expect(ack.participants).toEqual([]);
    expect(ack.messages).toEqual([]);
    expect(ack.self.id).not.toBe(maria.id);
    expect(server.roomManager.stats()).toEqual({ rooms: 1, participants: 1 });
  });

  it('комната удаляется, только когда вышел последний; другие комнаты не затрагиваются', async () => {
    const server = await startTestServer();
    const maria = await connectAndJoin(server, ROOM_ID, 'Мария');
    const alex = await connectAndJoin(server, ROOM_ID, 'Алекс');
    const olga = await connectAndJoin(server, 'other-room', 'Ольга');
    await request(olga.client, CLIENT_EVENTS.CHAT_SEND, { text: 'Другая комната' });

    await disconnectClient(maria.client);
    expect(server.roomManager.stats()).toEqual({ rooms: 2, participants: 2 });
    await disconnectClient(alex.client);
    expect(server.roomManager.stats()).toEqual({ rooms: 1, participants: 1 });

    const ivan = await connectAndJoin(server, 'other-room', 'Иван');
    await flushEvents(olga.client);
    expect(ivan.ack.participants).toEqual([olga.ack.self]);
    expect(ivan.ack.messages.map((message) => message.text ?? message.event)).toEqual([
      'joined',
      'Другая комната',
    ]);
    expect(payloadsOf(olga.client, SERVER_EVENTS.PARTICIPANT_LEFT)).toEqual([]);
  });
});
