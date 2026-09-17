// Точка входа сервера (TDD §4.2.1, §12.1, §12.5): конфигурация → HTTP(S)-сервер → Express →
// Socket.io, остановка по SIGINT/SIGTERM. Модуль можно импортировать (интеграционные тесты):
// сервер запускается сам, только если файл передан node как скрипт.
import { once } from 'node:events';
import { readFileSync, realpathSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { ConfigError, loadConfig } from './config.js';
import { createApp } from './http/app.js';
import { createLogger } from './logger.js';
import { RoomManager } from './rooms/RoomManager.js';
import { RateLimiter } from './socket/rateLimiter.js';
import { registerHandlers } from './socket/registerHandlers.js';

/** @typedef {import('./config.js').ServerConfig} ServerConfig */

/**
 * Параметры Socket.io (TDD §6.2, §10.4). Обрыв сети сервер замечает не позже чем через
 * pingInterval + pingTimeout = 15 с. `connectionStateRecovery` не включается: автопереподключения
 * нет (FR-31).
 */
export const SOCKET_OPTIONS = Object.freeze({
  pingInterval: 5_000,
  pingTimeout: 10_000,
  maxHttpBufferSize: 64 * 1024,
  // socket.io-client входит в сборку Vite: раздавать клиентский бандл с сервера не нужно.
  serveClient: false,
});

/** Сколько ждать завершения открытых HTTP-соединений при остановке, прежде чем оборвать их. */
export const SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * @typedef {Object} VcrServer
 * @property {import('node:http').Server | import('node:https').Server} httpServer  // ещё не слушает порт
 * @property {Server} io
 * @property {RoomManager} roomManager
 * @property {() => Promise<void>} close  // идемпотентная остановка
 */

/**
 * Собирает сервер, но не начинает слушать порт: это делает `main` или тест (`listen(0)`).
 * @param {Readonly<ServerConfig>} config
 * @param {{ logger?: import('pino').Logger, shutdownTimeoutMs?: number }} [options]
 * @returns {VcrServer}
 */
export function createServer(
  config,
  {
    logger = createLogger({ level: config.logLevel }),
    shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS,
  } = {},
) {
  const roomManager = new RoomManager({ historyLimit: config.chatHistoryLimit });
  const app = createApp(config, { roomManager, logger });
  const httpServer = config.ssl
    ? createHttpsServer(
        {
          cert: readTlsFile('SSL_CERT_PATH', config.ssl.certPath),
          key: readTlsFile('SSL_KEY_PATH', config.ssl.keyPath),
        },
        app,
      )
    : createHttpServer(app);
  // Копия: Socket.io дописывает в объект параметров значения по умолчанию.
  const io = new Server(httpServer, { ...SOCKET_OPTIONS });
  registerHandlers(io, {
    roomManager,
    rateLimiter: new RateLimiter(),
    logger,
    iceServers: config.iceServers,
  });

  let closing = null;
  /**
   * Отключает клиентов Socket.io (у них CONNECTION_LOST) и закрывает HTTP-сервер. Соединения,
   * не завершившиеся за `shutdownTimeoutMs`, обрываются.
   */
  const close = () => {
    closing ??= new Promise((resolve, reject) => {
      const forceTimer = setTimeout(() => {
        logger.warn({ timeoutMs: shutdownTimeoutMs }, 'shutdown timeout: closing connections');
        httpServer.closeAllConnections();
      }, shutdownTimeoutMs);
      forceTimer.unref();

      // io.close() закрывает и HTTP-сервер, к которому подключён Socket.io.
      io.close((error) => {
        clearTimeout(forceTimer);
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
    });
    return closing;
  };

  return { httpServer, io, roomManager, close };
}

/**
 * Запускает сервер по конфигурации из окружения и останавливает его по SIGINT/SIGTERM.
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<VcrServer & { shutdown: (signal: string) => Promise<void> }>}
 * @throws {ConfigError}  при некорректной конфигурации
 */
export async function main(env = process.env) {
  const config = loadConfig(env);
  const logger = createLogger({ level: config.logLevel });
  const server = createServer(config, { logger });
  const { httpServer } = server;

  httpServer.listen(config.port, config.host);
  await once(httpServer, 'listening'); // ошибка listen (например, EADDRINUSE) — исключение
  const { port } = httpServer.address();
  logger.info(
    { protocol: config.ssl ? 'https' : 'http', host: config.host, port },
    'server listening',
  );

  const shutdown = async (signal) => {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    logger.info({ signal }, 'shutting down');
    await server.close();
    logger.info('server stopped');
  };
  // Повторный сигнал во время остановки обрабатывается Node по умолчанию: процесс завершается.
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return { ...server, shutdown };
}

function readTlsFile(variable, path) {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new Error(`${variable}: не удалось прочитать ${path} (${error.code ?? error.message})`, {
      cause: error,
    });
  }
}

/** Файл запущен как `node server/src/index.js`, а не импортирован. */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    // native: одинаковый регистр букв диска и разрешённые ссылки с обеих сторон.
    return (
      realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error) => {
    console.error(error instanceof ConfigError ? error.message : error);
    process.exitCode = 1;
  });
}
