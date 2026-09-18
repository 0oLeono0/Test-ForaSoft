// Лёгкий нагрузочный прогон сигналинга (TDD §9.1, §11.5): 50 комнат по 4 сокета, на каждого
// участника 30 фиктивных `signal` и 20 сообщений чата. Медиа идёт P2P, поэтому нагружать сервер
// имеет смысл только сигналингом.
//
// Сервер поднимается отдельным процессом — fork этого же файла в роли `server`. Так RSS из
// `process.memoryUsage()` относится к одному лишь серверу: две сотни клиентских сокетов живут
// в процессе-родителе и в измерение не попадают. Счётчики комнат берутся из `/healthz` (TDD §6.1),
// критерии — из §11.5: ни одного лишнего `ROOM_FULL`, RSS < 150 МБ, p95 доставки чата < 50 мс.
//
// Запуск: node scripts/load-signaling.js [--rooms=50] [--messages=20] [--signals=30]
// Код возврата 1, если хотя бы один критерий не выполнен.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLIENT_EVENTS, ERROR_CODES, MAX_PARTICIPANTS, SERVER_EVENTS } from '@vcr/shared';
import { io as createClient } from 'socket.io-client';
import { RATE_LIMITS } from '../server/src/socket/rateLimiter.js';

/** Значения по умолчанию из TDD §11.5; каждое переопределяется флагом вида `--rooms=10`. */
const DEFAULT_OPTIONS = Object.freeze({
  rooms: 50,
  participants: MAX_PARTICIPANTS,
  messages: 20,
  signals: 30,
});

/** Критерии приёмки прогона (TDD §9.1, §11.5). */
const CRITERIA = Object.freeze({
  maxRssBytes: 150 * 1024 * 1024,
  maxChatP95Ms: 50,
});

/**
 * Пауза между сообщениями одного участника. Rate limit чата — 5 сообщений за 5 с (TDD §10.4),
 * то есть в среднем одно в секунду; запас в 10% отделяет нагрузку от проверки лимита, у которой
 * есть свои тесты.
 */
const CHAT_INTERVAL_MS = Math.ceil((RATE_LIMITS.chat.windowMs / RATE_LIMITS.chat.capacity) * 1.1);

/** Пауза между раундами сигналинга: всплеск ICE-кандидатов приходит волнами, а не разом. */
const SIGNAL_ROUND_DELAY_MS = 20;

/** Сколько ждать последние сообщения, прежде чем считать статистику. */
const SETTLE_MS = 1_000;

/** Комнат в одной волне подключений: 40 одновременных рукопожатий вместо двух сотен. */
const CONNECT_BATCH_ROOMS = 10;

/** Как часто опрашивать RSS сервера, чтобы поймать пик. */
const MEMORY_SAMPLE_MS = 500;

/** Двести сокетов входят почти одновременно, поэтому ack ждём дольше обычного. */
const ACK_TIMEOUT_MS = 10_000;

/** Параметры клиента совпадают с браузерными (TDD §6.2), кроме увеличенного таймаута. */
const CLIENT_OPTIONS = Object.freeze({ autoConnect: false, reconnection: false, timeout: 10_000 });

/** SDP ~4 КБ: примерно столько занимает offer с видео и аудио. Содержимое сервер не разбирает. */
const FAKE_SDP = 'a=candidate:0 1 UDP 2122252543 192.168.1.50 50000 typ host '.repeat(70);

/** Каждый десятый сигнал — offer, остальные — ICE-кандидаты: так выглядит согласование пары. */
const OFFER_EVERY = 10;

if (process.env.VCR_LOAD_ROLE === 'server') await runServerRole();
else await runLoadRole();

/**
 * Роль `server`: поднимает настоящий сервер на эфемерном порту и отвечает родителю на запросы
 * `memory`. Порт 0 выбран, чтобы прогон не зависел от занятого 3000-го и не мешал dev-серверу.
 */
async function runServerRole() {
  const { main } = await import('../server/src/index.js');
  const server = await main({
    ...process.env,
    PORT: '0',
    HOST: '127.0.0.1',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  });
  const { port } = server.httpServer.address();

  process.on('message', (message) => {
    if (message?.type === 'memory') {
      process.send({ type: 'memory', id: message.id, memory: process.memoryUsage() });
    }
  });
  process.send({ type: 'ready', port });
}

/** Роль по умолчанию: прогон нагрузки и отчёт. */
async function runLoadRole() {
  const options = parseOptions(process.argv.slice(2));
  const totalSockets = options.rooms * options.participants;
  console.log(
    `Нагрузка: ${options.rooms} комнат по ${options.participants} участника, ` +
      `${options.signals} сигналов и ${options.messages} сообщений на участника ` +
      `(${totalSockets} сокетов)`,
  );

  const server = await startServerProcess();
  const memory = { baselineRss: 0, peakRss: 0, finalRss: 0 };
  let sampler = null;
  try {
    memory.baselineRss = (await server.memory()).rss;
    sampler = setInterval(() => {
      // Процесс сервера мог остановиться между опросами: пик к этому моменту уже снят.
      server
        .memory()
        .then(({ rss }) => {
          memory.peakRss = Math.max(memory.peakRss, rss);
        })
        .catch(() => {});
    }, MEMORY_SAMPLE_MS);

    const counters = createCounters();
    const participants = await connectAll(server.url, options, counters);
    const healthUnderLoad = await fetchHealth(server.url);

    await runSignalPhase(participants, options, counters);
    await runChatPhase(participants, options, counters);
    await delay(SETTLE_MS);
    memory.finalRss = (await server.memory()).rss;

    clearInterval(sampler);
    sampler = null;
    for (const participant of participants) participant.client.disconnect();
    await delay(SETTLE_MS);
    const healthAfter = await fetchHealth(server.url);

    const report = buildReport({ options, counters, memory, healthUnderLoad, healthAfter });
    printReport(report);
    process.exitCode = report.passed ? 0 : 1;
  } finally {
    if (sampler) clearInterval(sampler);
    await server.stop();
  }
}

/** @returns {{ rooms: number, participants: number, messages: number, signals: number }} */
function parseOptions(argv) {
  const options = { ...DEFAULT_OPTIONS };
  const keys = Object.keys(options).join('|');
  for (const arg of argv) {
    const match = /^--([a-z]+)=([0-9]+)$/.exec(arg);
    const value = match ? Number(match[2]) : 0;
    if (!match || !Object.hasOwn(options, match[1]) || value < 1) {
      throw new Error(`Непонятный аргумент: ${arg}. Ожидается --(${keys})=<число больше нуля>`);
    }
    options[match[1]] = value;
  }
  return options;
}

/**
 * Запускает сервер отдельным процессом и ждёт, пока он начнёт слушать порт.
 * @returns {Promise<{ url: string, memory: () => Promise<object>, stop: () => Promise<void> }>}
 */
async function startServerProcess() {
  const child = fork(fileURLToPath(import.meta.url), [], {
    env: { ...process.env, VCR_LOAD_ROLE: 'server' },
  });
  /** @type {Map<number, (memory: object) => void>} */
  const pending = new Map();
  let nextId = 0;
  let onReady = null;

  const started = new Promise((resolve, reject) => {
    onReady = resolve;
    child.once('error', reject);
    child.once('exit', (code) =>
      reject(new Error(`Сервер завершился до готовности (код ${code})`)),
    );
  });
  child.on('message', (message) => {
    if (message?.type === 'ready') onReady(message.port);
    if (message?.type === 'memory') {
      pending.get(message.id)?.(message.memory);
      pending.delete(message.id);
    }
  });

  const port = await started;
  child.removeAllListeners('exit'); // дальше выход процесса ждёт stop()

  return {
    url: `http://127.0.0.1:${port}`,
    memory: () =>
      new Promise((resolve, reject) => {
        if (!child.connected) {
          reject(new Error('Процесс сервера остановлен'));
          return;
        }
        nextId += 1;
        pending.set(nextId, resolve);
        child.send({ type: 'memory', id: nextId });
      }),
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM'); // штатная остановка: io.close(), затем server.close() (TDD §12.5)
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}

function createCounters() {
  return {
    /** Ответы ROOM_FULL при входе: в комнате ровно 4 участника, поэтому любой из них лишний. */
    roomFull: 0,
    /** Прочие коды ошибок входа, чтобы прогон не выглядел успешным из-за невошедших. */
    joinErrors: new Map(),
    /** Ошибки ack на chat:send, в первую очередь RATE_LIMITED. */
    chatErrors: new Map(),
    /** Коды из `signal:error` у отправителя. */
    signalErrors: new Map(),
    /** Сигналы, дошедшие до адресата. */
    signalsDelivered: 0,
    /** Время отправки сообщения по его тексту: текст уникален в пределах прогона. */
    sentAt: new Map(),
    /** Задержки доставки чата в миллисекундах — по одной на получателя, кроме автора. */
    latencies: [],
  };
}

/**
 * Подключает и вводит в комнаты всех участников волнами по `CONNECT_BATCH_ROOMS` комнат.
 * Внутри комнаты четыре входа идут одновременно — заодно это проверка атомарности лимита (FR-7).
 * @returns {Promise<Array<{ client: object, id: string, peers: string[], label: string }>>}
 */
async function connectAll(url, options, counters) {
  const participants = [];
  for (let first = 0; first < options.rooms; first += CONNECT_BATCH_ROOMS) {
    const last = Math.min(first + CONNECT_BATCH_ROOMS, options.rooms);
    const batch = [];
    for (let room = first; room < last; room += 1)
      batch.push(joinRoom(url, room, options, counters));
    for (const room of await Promise.all(batch)) participants.push(...room);
  }
  console.log(`Вошли в комнаты: ${participants.length} участников`);
  return participants;
}

/** Одна комната: сокеты подключаются, затем все разом отправляют room:join. */
async function joinRoom(url, room, options, counters) {
  const roomId = `load-${String(room).padStart(3, '0')}`;
  const clients = await Promise.all(
    Array.from({ length: options.participants }, () => connectClient(url)),
  );

  const joined = await Promise.all(
    clients.map(async (client, slot) => {
      const ack = await client.timeout(ACK_TIMEOUT_MS).emitWithAck(CLIENT_EVENTS.ROOM_JOIN, {
        roomId,
        name: `Load ${room} ${slot}`,
      });
      if (ack.ok) return { client, id: ack.self.id, peers: [], label: `${roomId}-${slot}` };
      if (ack.error.code === ERROR_CODES.ROOM_FULL) counters.roomFull += 1;
      else increment(counters.joinErrors, ack.error.code);
      client.disconnect();
      return null;
    }),
  );

  const participants = joined.filter(Boolean);
  for (const participant of participants) {
    participant.peers = participants.filter((peer) => peer !== participant).map((peer) => peer.id);
    listen(participant, counters);
  }
  return participants;
}

function connectClient(url) {
  // Копия: socket.io-client дописывает в объект параметров значения по умолчанию.
  const client = createClient(url, { ...CLIENT_OPTIONS });
  return new Promise((resolve, reject) => {
    client.once('connect', () => resolve(client));
    client.once('connect_error', reject);
    client.connect();
  });
}

/** Считает доставку чата и сигналов на стороне получателя. */
function listen(participant, counters) {
  participant.client.on(SERVER_EVENTS.CHAT_MESSAGE, ({ message }) => {
    // Автор получает свою же рассылку: у него задержка не показательна.
    if (message.type !== 'user' || message.authorId === participant.id) return;
    const sentAt = counters.sentAt.get(message.text);
    if (sentAt !== undefined) counters.latencies.push(performance.now() - sentAt);
  });
  participant.client.on(SERVER_EVENTS.SIGNAL, () => {
    counters.signalsDelivered += 1;
  });
  participant.client.on(SERVER_EVENTS.SIGNAL_ERROR, ({ code }) => {
    increment(counters.signalErrors, code);
  });
}

/** Каждый участник отправляет `signals` сигналов по кругу своим пирам. Ack у события нет. */
async function runSignalPhase(participants, options, counters) {
  for (let round = 0; round < options.signals; round += 1) {
    for (const participant of participants) {
      const to = participant.peers[round % participant.peers.length];
      participant.client.emit(CLIENT_EVENTS.SIGNAL, { to, data: signalData(round) });
    }
    await delay(SIGNAL_ROUND_DELAY_MS);
  }
  await delay(SETTLE_MS);
  const sent = participants.length * options.signals;
  console.log(`Сигналы: отправлено ${sent}, доставлено ${counters.signalsDelivered}`);
}

function signalData(round) {
  if (round % OFFER_EVERY === 0) return { type: 'offer', sdp: FAKE_SDP };
  return {
    type: 'candidate',
    candidate: {
      candidate: `candidate:${round} 1 UDP 2122252543 192.168.1.50 ${50_000 + round} typ host`,
      sdpMid: '0',
      sdpMLineIndex: 0,
    },
  };
}

/**
 * Каждый участник отправляет `messages` сообщений с паузой `CHAT_INTERVAL_MS`. Ack не ожидается:
 * задержка считается на стороне получателей, а ack нужен только чтобы заметить отказ сервера.
 */
async function runChatPhase(participants, options, counters) {
  for (let seq = 0; seq < options.messages; seq += 1) {
    for (const participant of participants) {
      const text = `load ${participant.label} ${seq}`;
      counters.sentAt.set(text, performance.now());
      participant.client.emit(CLIENT_EVENTS.CHAT_SEND, { text }, (ack) => {
        if (!ack?.ok) increment(counters.chatErrors, ack?.error?.code ?? 'NO_ACK');
      });
    }
    await delay(CHAT_INTERVAL_MS);
  }
  console.log(`Чат: отправлено ${participants.length * options.messages} сообщений`);
}

async function fetchHealth(url) {
  const response = await fetch(`${url}/healthz`);
  if (!response.ok) throw new Error(`/healthz ответил ${response.status}`);
  return response.json();
}

/** Сводит измерения и критерии §11.5 в отчёт. */
function buildReport({ options, counters, memory, healthUnderLoad, healthAfter }) {
  const sockets = options.rooms * options.participants;
  const expectedDeliveries = sockets * options.messages * (options.participants - 1);
  const p95 = percentile(counters.latencies, 95);
  const checks = [
    {
      name: 'Лишних ROOM_FULL нет',
      actual: String(counters.roomFull),
      expected: '0',
      passed: counters.roomFull === 0,
    },
    {
      name: 'Ошибок входа нет',
      actual: describeCounts(counters.joinErrors),
      expected: 'нет',
      passed: counters.joinErrors.size === 0,
    },
    {
      name: 'Ошибок чата нет',
      actual: describeCounts(counters.chatErrors),
      expected: 'нет',
      passed: counters.chatErrors.size === 0,
    },
    {
      name: 'Ошибок сигналинга нет',
      actual: describeCounts(counters.signalErrors),
      expected: 'нет',
      passed: counters.signalErrors.size === 0,
    },
    {
      name: 'Сигналы доставлены',
      actual: String(counters.signalsDelivered),
      expected: String(sockets * options.signals),
      passed: counters.signalsDelivered === sockets * options.signals,
    },
    {
      name: 'Сообщения доставлены всем',
      actual: String(counters.latencies.length),
      expected: String(expectedDeliveries),
      passed: counters.latencies.length === expectedDeliveries,
    },
    {
      name: 'Комнаты под нагрузкой',
      actual: `${healthUnderLoad.rooms} комнат, ${healthUnderLoad.participants} участников`,
      expected: `${options.rooms} комнат, ${sockets} участников`,
      passed: healthUnderLoad.rooms === options.rooms && healthUnderLoad.participants === sockets,
    },
    {
      name: 'Комнаты освободились после выхода',
      actual: `${healthAfter.rooms} комнат`,
      expected: '0 комнат',
      passed: healthAfter.rooms === 0,
    },
    {
      name: 'p95 доставки чата',
      actual: `${p95.toFixed(1)} мс`,
      expected: `< ${CRITERIA.maxChatP95Ms} мс`,
      passed: p95 < CRITERIA.maxChatP95Ms,
    },
    {
      name: 'Пиковый RSS сервера',
      actual: formatMib(memory.peakRss),
      expected: `< ${formatMib(CRITERIA.maxRssBytes)}`,
      passed: memory.peakRss < CRITERIA.maxRssBytes,
    },
  ];

  return {
    checks,
    passed: checks.every((check) => check.passed),
    latency: {
      count: counters.latencies.length,
      p50: percentile(counters.latencies, 50),
      p95,
      p99: percentile(counters.latencies, 99),
      max: counters.latencies.length > 0 ? Math.max(...counters.latencies) : Number.NaN,
    },
    memory,
    version: healthUnderLoad.version,
  };
}

/** Таблица печатается в Markdown: результат прогона переносится в docs/load-test.md как есть. */
function printReport({ checks, passed, latency, memory, version }) {
  console.log('');
  console.log('| Проверка | Получено | Ожидалось | Итог |');
  console.log('| --- | --- | --- | --- |');
  for (const check of checks) {
    console.log(
      `| ${check.name} | ${check.actual} | ${check.expected} | ${verdict(check.passed)} |`,
    );
  }
  console.log('');
  console.log(
    `Задержка чата, мс: p50 ${latency.p50.toFixed(1)}, p95 ${latency.p95.toFixed(1)}, ` +
      `p99 ${latency.p99.toFixed(1)}, max ${latency.max.toFixed(1)} (замеров ${latency.count})`,
  );
  console.log(
    `RSS сервера: старт ${formatMib(memory.baselineRss)}, пик ${formatMib(memory.peakRss)}, ` +
      `после нагрузки ${formatMib(memory.finalRss)}`,
  );
  console.log(`Версия сервера ${version}, Node ${process.version}, ${process.platform}`);
  console.log(passed ? 'ИТОГ: все критерии выполнены' : 'ИТОГ: критерии не выполнены');
}

function verdict(passed) {
  return passed ? 'ок' : 'не ок';
}

/** Интерполяция не нужна: берётся ближайший замер сверху. */
function percentile(values, share) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((share / 100) * sorted.length) - 1);
  return sorted[index];
}

function formatMib(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function describeCounts(counts) {
  if (counts.size === 0) return 'нет';
  return [...counts].map(([code, count]) => `${code}: ${count}`).join(', ');
}

function increment(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
