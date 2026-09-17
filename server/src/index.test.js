import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Server as HttpServer } from 'node:http';
import { Server as HttpsServer, request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketIoServer } from 'socket.io';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConfigError, loadConfig } from './config.js';
import { SHUTDOWN_TIMEOUT_MS, SOCKET_OPTIONS, createServer, main } from './index.js';

// Самоподписанный сертификат только для тестов: CN=localhost, SAN localhost и 127.0.0.1, до 2126 г.
const TLS_DIR = fileURLToPath(new URL('../test/fixtures/tls/', import.meta.url));

let distDir;
/** Серверы, которые нужно остановить после теста. */
const started = [];

beforeAll(() => {
  distDir = mkdtempSync(join(tmpdir(), 'vcr-server-'));
});

afterEach(async () => {
  await Promise.all(started.splice(0).map((server) => server.close()));
});

afterAll(() => {
  rmSync(distDir, { recursive: true, force: true });
});

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function testConfig(env = {}) {
  return loadConfig({ LOG_LEVEL: 'silent', CLIENT_DIST_DIR: distDir, ...env });
}

/** Создаёт сервер и начинает слушать эфемерный порт на 127.0.0.1. */
async function startServer(config = testConfig(), options = {}) {
  const server = createServer(config, { logger: fakeLogger(), ...options });
  started.push(server);
  server.httpServer.listen(0, '127.0.0.1');
  await once(server.httpServer, 'listening');
  return { ...server, baseUrl: `http://127.0.0.1:${server.httpServer.address().port}` };
}

/**
 * Клиент Socket.io на протоколе long-polling (Engine.IO 4) без клиентской библиотеки:
 * подключается к namespace `/` и отправляет события с ack.
 */
async function connectPolling(baseUrl) {
  const endpoint = `${baseUrl}/socket.io/?EIO=4&transport=polling`;
  const handshake = await (await fetch(endpoint)).text();
  const url = `${endpoint}&sid=${JSON.parse(handshake.slice(1)).sid}`;

  const post = async (packet) => {
    expect(await (await fetch(url, { method: 'POST', body: packet })).text()).toBe('ok');
  };
  // Пакеты в одном ответе разделены символом RS (0x1E).
  const poll = async () => (await (await fetch(url)).text()).split('\x1e');

  await post('40');
  expect((await poll())[0]).toMatch(/^40\{"sid":/);

  let ackId = 0;
  return {
    /** Отправляет событие и возвращает payload ack. */
    async request(event, payload) {
      ackId += 1;
      await post(`42${ackId}${JSON.stringify([event, payload])}`);
      const ack = (await poll()).find((packet) => packet.startsWith(`43${ackId}[`));
      return JSON.parse(ack.slice(`43${ackId}`.length))[0];
    },
  };
}

describe('createServer', () => {
  it('без SSL собирает HTTP-сервер с Socket.io и не слушает порт до listen', () => {
    const server = createServer(testConfig(), { logger: fakeLogger() });
    started.push(server);

    expect(server.httpServer).toBeInstanceOf(HttpServer);
    expect(server.httpServer).not.toBeInstanceOf(HttpsServer);
    expect(server.httpServer.listening).toBe(false);
    expect(server.io).toBeInstanceOf(SocketIoServer);
    expect(server.roomManager.stats()).toEqual({ rooms: 0, participants: 0 });
  });

  it('параметры Socket.io из TDD §6.2 видны клиенту в handshake', async () => {
    const { baseUrl } = await startServer();

    const response = await fetch(`${baseUrl}/socket.io/?EIO=4&transport=polling`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body.startsWith('0')).toBe(true);
    expect(JSON.parse(body.slice(1))).toMatchObject({
      pingInterval: 5000,
      pingTimeout: 10000,
      maxPayload: 64 * 1024,
    });
  });

  it('SOCKET_OPTIONS: без connectionStateRecovery и без раздачи клиентского бандла', async () => {
    expect(SOCKET_OPTIONS).toEqual({
      pingInterval: 5000,
      pingTimeout: 10000,
      maxHttpBufferSize: 65536,
      serveClient: false,
    });
    expect(Object.isFrozen(SOCKET_OPTIONS)).toBe(true);

    const { baseUrl } = await startServer();
    const response = await fetch(`${baseUrl}/socket.io/socket.io.js`);
    expect(response.headers.get('content-type')).not.toMatch(/javascript/);
  });

  it('Express обслуживает HTTP-запросы: /healthz видит комнаты RoomManager', async () => {
    const { baseUrl, roomManager } = await startServer();
    roomManager.join({ roomId: 'room-a', name: 'Мария', socketId: 's1' });

    const response = await fetch(`${baseUrl}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ok', rooms: 1, participants: 1 });
  });

  it('обработчики событий подключены: room:join отвечает ack с iceServers из конфигурации', async () => {
    const config = testConfig({ STUN_URLS: 'stun:192.168.1.10:3478' });
    const { baseUrl, roomManager } = await startServer(config);
    const client = await connectPolling(baseUrl);

    const ack = await client.request('room:join', { roomId: 'V1StGXR8_Z', name: 'Мария' });

    expect(ack).toMatchObject({
      ok: true,
      self: { name: 'Мария' },
      participants: [],
      iceServers: [{ urls: 'stun:192.168.1.10:3478' }],
    });
    expect(roomManager.stats()).toEqual({ rooms: 1, participants: 1 });
  });

  it('close отключает участников: их комнаты удаляются', async () => {
    const server = await startServer();
    const client = await connectPolling(server.baseUrl);
    await client.request('room:join', { roomId: 'V1StGXR8_Z', name: 'Мария' });

    await server.close();

    expect(server.roomManager.stats()).toEqual({ rooms: 0, participants: 0 });
  });

  it('размер истории чата берётся из конфигурации', () => {
    const server = createServer(testConfig({ CHAT_HISTORY_LIMIT: '2' }), { logger: fakeLogger() });
    started.push(server);
    const { participant } = server.roomManager.join({ roomId: 'r', name: 'Мария', socketId: 's' });

    for (const text of ['раз', 'два', 'три'])
      server.roomManager.addChatMessage(participant.id, text);

    const { messages } = server.roomManager.getRoomOf(participant.id).snapshot();
    expect(messages.map((message) => message.text)).toEqual(['два', 'три']);
  });

  it('с SSL_CERT_PATH и SSL_KEY_PATH отвечает по HTTPS', async () => {
    const config = testConfig({
      SSL_CERT_PATH: join(TLS_DIR, 'cert.pem'),
      SSL_KEY_PATH: join(TLS_DIR, 'key.pem'),
    });
    const { httpServer } = await startServer(config);

    expect(httpServer).toBeInstanceOf(HttpsServer);
    const response = await new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          host: '127.0.0.1',
          port: httpServer.address().port,
          path: '/healthz',
          servername: 'localhost',
          ca: readFileSync(join(TLS_DIR, 'cert.pem')),
        },
        resolve,
      );
      req.on('error', reject);
      req.end();
    });
    response.resume();

    expect(response.statusCode).toBe(200);
    expect(response.socket.encrypted).toBe(true);
  });

  it.each([
    [
      'SSL_CERT_PATH',
      { SSL_CERT_PATH: 'missing-cert.pem', SSL_KEY_PATH: join(TLS_DIR, 'key.pem') },
    ],
    ['SSL_KEY_PATH', { SSL_CERT_PATH: join(TLS_DIR, 'cert.pem'), SSL_KEY_PATH: 'missing-key.pem' }],
  ])('нечитаемый файл %s — понятная ошибка', (variable, env) => {
    const config = testConfig(env);

    expect(() => createServer(config, { logger: fakeLogger() })).toThrow(
      new RegExp(`^${variable}: не удалось прочитать .*missing-.*\\.pem \\(ENOENT\\)$`),
    );
  });
});

describe('createServer: close', () => {
  it('останавливает HTTP-сервер и отключает клиентов Socket.io; повторный вызов — тот же промис', async () => {
    const server = await startServer();
    const handshake = await (
      await fetch(`${server.baseUrl}/socket.io/?EIO=4&transport=polling`)
    ).text();
    const { sid } = JSON.parse(handshake.slice(1));
    expect(server.io.engine.clientsCount).toBe(1);

    const closing = server.close();

    expect(server.close()).toBe(closing);
    await closing;
    expect(server.httpServer.listening).toBe(false);
    expect(server.io.engine.clientsCount).toBe(0);
    await expect(
      fetch(`${server.baseUrl}/socket.io/?EIO=4&transport=polling&sid=${sid}`),
    ).rejects.toThrow();
  });

  it('без зависших соединений не ждёт таймаута', async () => {
    const logger = fakeLogger();
    const server = await startServer(testConfig(), { logger });
    await (await fetch(`${server.baseUrl}/healthz`)).text();

    const startedAt = Date.now();
    await server.close();

    expect(Date.now() - startedAt).toBeLessThan(SHUTDOWN_TIMEOUT_MS);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('незавершённый запрос обрывается по таймауту остановки', async () => {
    const logger = fakeLogger();
    const server = await startServer(testConfig(), { logger, shutdownTimeoutMs: 200 });
    const client = connect(server.httpServer.address().port, '127.0.0.1');
    const clientClosed = once(client, 'close');
    const requestReceived = once(server.httpServer, 'request');
    // Тело запроса не дописано: Express ждёт его конца, соединение остаётся занятым.
    client.write('POST /room/x HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\n\r\npartial');
    await requestReceived;

    const startedAt = Date.now();
    await server.close();

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    expect(logger.warn).toHaveBeenCalledWith(
      { timeoutMs: 200 },
      'shutdown timeout: closing connections',
    );
    await clientClosed;
  });

  it('до listen завершается без ошибки', async () => {
    const server = createServer(testConfig(), { logger: fakeLogger() });

    await expect(server.close()).resolves.toBeUndefined();
  });
});

describe('main', () => {
  const env = () => ({
    PORT: '0',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    CLIENT_DIST_DIR: distDir,
  });

  it('слушает порт из конфигурации и останавливается по shutdown, снимая обработчики сигналов', async () => {
    const listeners = {
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
    };

    const server = await main(env());
    started.push(server);

    expect(server.httpServer.listening).toBe(true);
    expect(server.httpServer.address().address).toBe('127.0.0.1');
    expect(process.listenerCount('SIGINT')).toBe(listeners.SIGINT + 1);
    expect(process.listenerCount('SIGTERM')).toBe(listeners.SIGTERM + 1);
    const response = await fetch(`http://127.0.0.1:${server.httpServer.address().port}/healthz`);
    expect(response.status).toBe(200);

    await server.shutdown('SIGTERM');

    expect(server.httpServer.listening).toBe(false);
    expect(process.listenerCount('SIGINT')).toBe(listeners.SIGINT);
    expect(process.listenerCount('SIGTERM')).toBe(listeners.SIGTERM);
  });

  it('некорректная конфигурация — ConfigError, сервер не создаётся', async () => {
    await expect(main({ ...env(), PORT: 'http' })).rejects.toBeInstanceOf(ConfigError);
  });

  it('занятый порт — ошибка listen, сигналы не перехватываются', async () => {
    const occupied = await startServer();
    const listeners = process.listenerCount('SIGTERM');

    await expect(
      main({ ...env(), PORT: String(occupied.httpServer.address().port) }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(process.listenerCount('SIGTERM')).toBe(listeners);
  });
});
