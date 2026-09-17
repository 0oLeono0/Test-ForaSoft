// Проверка самого стенда: сервер, клиенты, ожидание событий и закрытие после теста.
import { CLIENT_EVENTS, ERROR_CODES, SERVER_EVENTS } from '@vcr/shared';
import { describe, expect, it } from 'vitest';
import {
  CLIENT_OPTIONS,
  clearReceivedEvents,
  closeTestResources,
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

describe('startTestServer', () => {
  it('слушает эфемерный порт на 127.0.0.1 и отвечает по HTTP', async () => {
    const server = await startTestServer();

    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(server.httpServer.address().port).not.toBe(3000);
    const response = await fetch(`${server.url}/healthz`);
    expect(await response.json()).toMatchObject({ status: 'ok', rooms: 0, participants: 0 });
  });

  it('переменные окружения применяются поверх значений по умолчанию', async () => {
    const server = await startTestServer({ STUN_URLS: 'stun:192.168.1.10:3478' });
    const client = await connectClient(server);

    const ack = await joinAs(client, ROOM_ID, 'Мария');

    expect(ack.iceServers).toEqual([{ urls: 'stun:192.168.1.10:3478' }]);
  });
});

describe('connectClient', () => {
  it('подключает клиента с параметрами из TDD §6.2: сервер видит сокет с тем же id', async () => {
    const server = await startTestServer();

    const client = await connectClient(server);

    expect(client.connected).toBe(true);
    expect(server.io.sockets.sockets.has(client.id)).toBe(true);
    expect(client.io.reconnection()).toBe(false);
    expect(client.io.timeout()).toBe(CLIENT_OPTIONS.timeout);
  });

  it('у каждого клиента своё соединение, в том числе после отключения предыдущего', async () => {
    const server = await startTestServer();

    const first = await connectClient(server);
    const second = await connectClient(server);
    first.disconnect();
    const third = await connectClient(server);

    expect(new Set([first.io, second.io, third.io]).size).toBe(3);
    expect(third.connected).toBe(true);
  });

  it('сервер недоступен — ошибка подключения', async () => {
    const server = await startTestServer();
    await server.close();

    await expect(connectClient(server)).rejects.toThrow();
  });
});

describe('request и joinAs', () => {
  it('joinAs возвращает успешный ack, участник занимает слот', async () => {
    const server = await startTestServer();
    const client = await connectClient(server);

    const ack = await joinAs(client, ROOM_ID, 'Мария');

    expect(ack).toMatchObject({ ok: true, self: { name: 'Мария' }, participants: [] });
    expect(server.roomManager.stats()).toEqual({ rooms: 1, participants: 1 });
  });

  it('connectAndJoin подключает нового клиента с заданными параметрами и входит им в комнату', async () => {
    const server = await startTestServer();

    const maria = await connectAndJoin(server, ROOM_ID, 'Мария');
    const alex = await connectAndJoin(server, ROOM_ID, 'Алекс', { transports: ['websocket'] });

    expect(maria.client).not.toBe(alex.client);
    expect(alex.client.connected).toBe(true);
    expect(alex.client.io.engine.transport.name).toBe('websocket');
    expect(alex.id).toBe(alex.ack.self.id);
    expect(alex.ack.participants).toEqual([maria.ack.self]);
  });

  it('joinAs: неудачный вход — исключение с кодом ошибки', async () => {
    const server = await startTestServer();
    const client = await connectClient(server);

    await expect(joinAs(client, ROOM_ID, '<b>')).rejects.toThrow(/INVALID_NAME/);
  });

  it('request возвращает ack с ошибкой как есть; событие можно отправить без payload', async () => {
    const server = await startTestServer();
    const client = await connectClient(server);

    const ack = await request(client, CLIENT_EVENTS.ROOM_LEAVE);

    expect(ack).toMatchObject({ ok: false, error: { code: ERROR_CODES.NOT_IN_ROOM } });
  });

  it('request: нет ack — понятная ошибка', async () => {
    const server = await startTestServer();
    const client = await connectClient(server);

    // media:state не отвечает (TDD §6.3).
    await expect(
      request(client, CLIENT_EVENTS.MEDIA_STATE, { audio: true, video: true }),
    ).rejects.toThrow(/Нет ack на media:state/);
  });
});

describe('waitForEvent', () => {
  it('возвращает payload первого события, для которого предикат истинен', async () => {
    const server = await startTestServer();
    const client = await connectClient(server);

    const waiting = waitForEvent(client, 'custom', (payload) => payload.n === 2);
    server.io.to(client.id).emit('custom', { n: 1 });
    server.io.to(client.id).emit('custom', { n: 2 });
    server.io.to(client.id).emit('custom', { n: 3 });

    await expect(waiting).resolves.toEqual({ n: 2 });
  });

  it('ждёт событие настоящего обработчика: participant:joined при входе второго', async () => {
    const server = await startTestServer();
    const maria = await connectClient(server);
    const alex = await connectClient(server);
    await joinAs(maria, ROOM_ID, 'Мария');

    const joined = waitForEvent(maria, SERVER_EVENTS.PARTICIPANT_JOINED);
    const ack = await joinAs(alex, ROOM_ID, 'Алекс');

    await expect(joined).resolves.toEqual({ participant: ack.self });
  });

  it('событие, пришедшее до вызова, не засчитывается; по таймауту — ошибка с именем события', async () => {
    const server = await startTestServer();
    const client = await connectClient(server);
    server.io.to(client.id).emit('custom', 1);
    await flushEvents(client);

    await expect(waitForEvent(client, 'custom', undefined, 50)).rejects.toThrow(
      'Событие custom не пришло за 50 мс',
    );
  });

  it('исключение в предикате отклоняет ожидание', async () => {
    const server = await startTestServer();
    const client = await connectClient(server);

    const waiting = waitForEvent(client, 'custom', () => {
      throw new Error('предикат');
    });
    server.io.to(client.id).emit('custom', 1);

    await expect(waiting).rejects.toThrow('предикат');
  });
});

describe('журнал событий и flushEvents', () => {
  it('после flushEvents журнал содержит всё, что сервер уже отправил, без служебного события', async () => {
    const server = await startTestServer();
    const first = await connectClient(server);
    const second = await connectClient(server);
    server.io.to(first.id).emit('a', 1);
    server.io.to(first.id).emit('b', 2);
    server.io.to(second.id).emit('a', 3);

    await flushEvents(first, second);

    expect(receivedEvents(first)).toEqual([
      { event: 'a', payload: 1 },
      { event: 'b', payload: 2 },
    ]);
    expect(payloadsOf(first, 'b')).toEqual([2]);
    expect(payloadsOf(second, 'a')).toEqual([3]);
  });

  it('clearReceivedEvents очищает журнал: дальше видны только новые события', async () => {
    const server = await startTestServer();
    const maria = await connectClient(server);
    const alex = await connectClient(server);
    await joinAs(maria, ROOM_ID, 'Мария');
    await joinAs(alex, ROOM_ID, 'Алекс');
    await flushEvents(maria);
    expect(payloadsOf(maria, SERVER_EVENTS.PARTICIPANT_JOINED)).toHaveLength(1);

    clearReceivedEvents(maria);
    await request(alex, CLIENT_EVENTS.ROOM_LEAVE);
    await flushEvents(maria);

    expect(receivedEvents(maria).map((entry) => entry.event)).toEqual([
      SERVER_EVENTS.PARTICIPANT_LEFT,
      SERVER_EVENTS.CHAT_MESSAGE,
    ]);
  });
});

describe('закрытие после теста', () => {
  /** Ресурсы первого теста, которые второй проверяет после afterEach. */
  let leftover;

  it('ресурсы теста живы до его конца', async () => {
    const server = await startTestServer();
    const client = await connectClient(server);
    await joinAs(client, ROOM_ID, 'Мария');
    // Без снятия в afterEach ожидание отклонилось бы по таймауту уже во время следующего теста.
    const outcome = waitForEvent(client, 'never', undefined, 100).then(
      () => 'resolved',
      () => 'rejected',
    );
    leftover = { server, client, outcome };

    expect(server.httpServer.listening).toBe(true);
  });

  it('afterEach отключил клиентов, остановил серверы и снял ожидания', async () => {
    const { server, client, outcome } = leftover;

    expect(client.connected).toBe(false);
    expect(server.httpServer.listening).toBe(false);
    expect(server.roomManager.stats()).toEqual({ rooms: 0, participants: 0 });
    // Снятое ожидание не отклоняется: иначе незавершённый промис стал бы необработанной ошибкой.
    const settled = await Promise.race([
      outcome,
      new Promise((resolve) => setTimeout(() => resolve('pending'), 300)),
    ]);
    expect(settled).toBe('pending');
  });

  it('ошибка в логе сервера проваливает тест', async () => {
    const server = await startTestServer();
    const client = await connectClient(server);
    server.roomManager.join = () => {
      throw new Error('сбой RoomManager');
    };
    const ack = await request(client, CLIENT_EVENTS.ROOM_JOIN, { roomId: ROOM_ID, name: 'Мария' });
    expect(ack.error.code).toBe(ERROR_CODES.INTERNAL_ERROR);

    await expect(closeTestResources()).rejects.toThrow(/socket handler failed/);
    expect(server.httpServer.listening).toBe(false);
  });
});
