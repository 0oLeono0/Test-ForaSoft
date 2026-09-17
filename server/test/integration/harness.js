// Стенд интеграционных тестов сервера (TDD §11.1, §11.3): настоящий сервер из createServer на
// эфемерном порту и клиенты socket.io-client с параметрами браузерного клиента (TDD §6.2).
// Серверы, клиенты и ожидания, созданные за тест, закрываются в afterEach. Запись уровня warn и
// выше в логе сервера проваливает тест: исключение в обработчике (у событий без ack его больше
// никак не заметить), ответ 5xx или соединение, не закрывшееся при остановке сервера.
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { CLIENT_EVENTS } from '@vcr/shared';
import { io as createClient } from 'socket.io-client';
import { afterEach } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createServer } from '../../src/index.js';
import { createLogger } from '../../src/logger.js';

/** Сколько по умолчанию ждать события или ack. На localhost доставка занимает миллисекунды. */
export const WAIT_TIMEOUT_MS = 2_000;

/**
 * Параметры браузерного клиента (TDD §6.2). Транспорты по умолчанию, как в браузере: polling
 * с апгрейдом до WebSocket. Каждый клиент получает своё соединение, как отдельная вкладка:
 * сокеты одного namespace socket.io-client не мультиплексирует.
 */
export const CLIENT_OPTIONS = Object.freeze({
  autoConnect: false,
  reconnection: false,
  timeout: 5_000,
});

/** Служебное событие `flushEvents`. Сервер его не обрабатывает, в журнал клиента оно не пишется. */
const FLUSH_EVENT = 'test:flush';

/**
 * @typedef {Object} TestServer
 * @property {string} url  // http://127.0.0.1:<порт>
 * @property {import('node:http').Server} httpServer
 * @property {import('socket.io').Server} io
 * @property {import('../../src/rooms/RoomManager.js').RoomManager} roomManager
 * @property {object[]} logRecords  // записи лога сервера уровня warn и выше
 * @property {() => Promise<void>} close  // идемпотентная остановка
 */

/** @typedef {import('socket.io-client').Socket} ClientSocket */
/** @typedef {{ event: string, payload: unknown }} ReceivedEvent */

/** @type {Set<{ close: () => Promise<void>, logRecords: object[] }>} */
const servers = new Set();
/** @type {Set<ClientSocket>} */
const clients = new Set();
/** @type {WeakMap<ClientSocket, { server: TestServer, events: ReceivedEvent[] }>} */
const clientStates = new WeakMap();
/** @type {Set<{ dispose: () => void }>} */
const waiters = new Set();

// Модуль стенда выполняется заново для каждого файла тестов (изоляция Vitest по умолчанию),
// поэтому хук регистрируется в каждом файле, который его импортирует.
afterEach(closeTestResources);

/**
 * Запускает сервер на эфемерном порту 127.0.0.1. Окружение процесса не читается: результат не
 * зависит от переменных, заданных у разработчика.
 * @param {Record<string, string>} [env]  переменные из TDD §12.3 поверх значений по умолчанию
 * @returns {Promise<TestServer>}
 */
export async function startTestServer(env = {}) {
  const logRecords = [];
  const logger = createLogger(
    { level: 'warn' },
    { write: (line) => logRecords.push(JSON.parse(line)) },
  );
  const server = createServer(loadConfig(env), { logger });
  servers.add({ close: server.close, logRecords });

  server.httpServer.listen(0, '127.0.0.1');
  await once(server.httpServer, 'listening');
  const { port } = server.httpServer.address();
  return { ...server, url: `http://127.0.0.1:${port}`, logRecords };
}

/**
 * Подключает нового клиента. С момента создания клиент записывает все события сервера в журнал
 * (`receivedEvents`).
 * @param {TestServer} server
 * @param {Partial<import('socket.io-client').ManagerOptions & import('socket.io-client').SocketOptions>} [options]
 * @returns {Promise<ClientSocket>}  подключённый сокет
 * @throws {Error}  `connect_error`, если сервер недоступен
 */
export async function connectClient(server, options = {}) {
  const client = createClient(server.url, { ...CLIENT_OPTIONS, ...options });
  const events = [];
  client.onAny((event, payload) => {
    if (event !== FLUSH_EVENT) events.push({ event, payload });
  });
  clientStates.set(client, { server, events });
  clients.add(client);

  await new Promise((resolve, reject) => {
    const onConnect = () => {
      client.off('connect_error', onError);
      resolve();
    };
    const onError = (error) => {
      client.off('connect', onConnect);
      reject(error);
    };
    client.once('connect', onConnect);
    client.once('connect_error', onError);
    client.connect();
  });
  return client;
}

/**
 * Отправляет событие и ждёт ack.
 * @param {ClientSocket} client
 * @param {string} event
 * @param {...unknown} args  payload; без аргументов событие уходит без payload
 * @returns {Promise<any>}  ответ сервера
 * @throws {Error}  если ack не пришёл за `WAIT_TIMEOUT_MS`
 */
export async function request(client, event, ...args) {
  try {
    return await client.timeout(WAIT_TIMEOUT_MS).emitWithAck(event, ...args);
  } catch (error) {
    throw new Error(`Нет ack на ${event} за ${WAIT_TIMEOUT_MS} мс`, { cause: error });
  }
}

/**
 * Входит в комнату. Для подготовки сценария: неудачный вход — исключение, а не ack с ошибкой.
 * @param {ClientSocket} client
 * @param {string} roomId
 * @param {string} name
 * @returns {Promise<any>}  успешный ack `room:join`
 */
export async function joinAs(client, roomId, name) {
  const ack = await request(client, CLIENT_EVENTS.ROOM_JOIN, { roomId, name });
  if (!ack.ok) throw new Error(`${name} не вошёл в комнату ${roomId}: ${ack.error.code}`);
  return ack;
}

/**
 * Новый клиент, вошедший в комнату: участник для подготовки сценария.
 * @param {TestServer} server
 * @param {string} roomId
 * @param {string} name
 * @param {Parameters<typeof connectClient>[1]} [options]  параметры клиента, как у connectClient
 * @returns {Promise<{ client: ClientSocket, ack: any, id: string }>}  `id` — participantId
 */
export async function connectAndJoin(server, roomId, name, options = {}) {
  const client = await connectClient(server, options);
  const ack = await joinAs(client, roomId, name);
  return { client, ack, id: ack.self.id };
}

/**
 * Ждёт событие, пришедшее **после** вызова: ожидание создаётся до действия, которое его вызывает.
 * @param {ClientSocket} client
 * @param {string} event
 * @param {(payload: any) => boolean} [predicate]  события, для которых он ложен, пропускаются
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}  payload первого подходящего события
 */
export function waitForEvent(client, event, predicate = () => true, timeoutMs = WAIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const settle = (settleWith, value) => {
      clearTimeout(timer);
      client.off(event, listener);
      waiters.delete(waiter);
      settleWith(value);
    };
    const listener = (payload) => {
      try {
        if (predicate(payload)) settle(resolve, payload);
      } catch (error) {
        settle(reject, error);
      }
    };
    const timer = setTimeout(
      () => settle(reject, new Error(`Событие ${event} не пришло за ${timeoutMs} мс`)),
      timeoutMs,
    );
    // Незавершённое к концу теста ожидание снимается без отклонения промиса.
    const waiter = { dispose: () => settle(() => {}) };
    waiters.add(waiter);
    client.on(event, listener);
  });
}

/**
 * Дожидается, пока каждый клиент получит все события, которые сервер уже отправил ему. Socket.io
 * доставляет события сокета по порядку, поэтому служебное событие, отправленное последним,
 * приходит после них. Так проверяется, что событие **не** пришло: после ack действия — flush,
 * затем `receivedEvents`.
 * @param {...ClientSocket} targets  подключённые клиенты
 */
export async function flushEvents(...targets) {
  await Promise.all(
    targets.map((client) => {
      const token = randomUUID();
      const flushed = waitForEvent(client, FLUSH_EVENT, (value) => value === token);
      stateOf(client).server.io.to(client.id).emit(FLUSH_EVENT, token);
      return flushed;
    }),
  );
}

/**
 * Журнал событий, полученных клиентом, по порядку.
 * @param {ClientSocket} client
 * @returns {ReceivedEvent[]}
 */
export function receivedEvents(client) {
  return [...stateOf(client).events];
}

/**
 * Payload полученных клиентом событий `event` по порядку.
 * @param {ClientSocket} client
 * @param {string} event
 * @returns {any[]}
 */
export function payloadsOf(client, event) {
  return stateOf(client)
    .events.filter((entry) => entry.event === event)
    .map((entry) => entry.payload);
}

/**
 * Отключает клиента и ждёт, пока сервер обработает `disconnect`: к этому моменту участник уже
 * вышел из комнаты, даже если сообщить об этом некому. Обработчик приложения подписан на
 * `disconnect` раньше, поэтому выполняется до слушателя стенда.
 * @param {ClientSocket} client  подключённый клиент
 * @param {'disconnect' | 'transport'} [mode]  `disconnect` — `socket.disconnect()` клиента;
 *   `transport` — соединение закрывается без пакета Socket.io, как при закрытии вкладки
 * @returns {Promise<string>}  причина отключения, которую получил сервер
 */
export async function disconnectClient(client, mode = 'disconnect') {
  const serverSocket = stateOf(client).server.io.sockets.sockets.get(client.id);
  if (!serverSocket) throw new Error('Клиент не подключён к серверу');

  const disconnected = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Сервер не обработал отключение за ${WAIT_TIMEOUT_MS} мс`)),
      WAIT_TIMEOUT_MS,
    );
    serverSocket.once('disconnect', (reason) => {
      clearTimeout(timer);
      resolve(reason);
    });
  });
  if (mode === 'transport') client.io.engine.close();
  else client.disconnect();
  return disconnected;
}

/**
 * Очищает журналы, чтобы дальше проверять только новые события.
 * @param {...ClientSocket} targets
 */
export function clearReceivedEvents(...targets) {
  for (const client of targets) stateOf(client).events.length = 0;
}

/**
 * Отключает клиентов, останавливает серверы и снимает ожидания, созданные с прошлого вызова.
 * Вызывается в afterEach.
 * @throws {Error}  если сервер записал в лог предупреждение или ошибку
 */
export async function closeTestResources() {
  for (const waiter of waiters) waiter.dispose();
  for (const client of clients) client.disconnect();
  clients.clear();

  const closing = [...servers];
  servers.clear();
  await Promise.all(closing.map((server) => server.close()));

  const records = closing.flatMap((server) => server.logRecords);
  if (records.length > 0) {
    const lines = records.map((record) => JSON.stringify(record)).join('\n');
    throw new Error(`Сервер записал в лог предупреждения или ошибки:\n${lines}`);
  }
}

function stateOf(client) {
  const state = clientStates.get(client);
  if (!state) throw new Error('Клиент создан не через connectClient');
  return state;
}
