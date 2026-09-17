// HTTP-часть сервера (TDD §6.1, §10.2, §10.3): заголовки безопасности, статика собранного клиента,
// /healthz и SPA fallback. Socket.io подключается к HTTP-серверу отдельно и до Express запросы
// к /socket.io не доходят.
import { readFileSync } from 'node:fs';
import { STATUS_CODES } from 'node:http';
import { join } from 'node:path';
import express from 'express';
import helmet from 'helmet';

/** @typedef {import('../config.js').ServerConfig} ServerConfig */

/** Версия из `server/package.json` для `/healthz` (TDD §12.5). */
export const SERVER_VERSION = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;

/**
 * CSP из TDD §10.3. `connect-src 'self'` разрешает и WebSocket на тот же хост и порт, поэтому
 * `ws:`/`wss:` на любые хосты не добавляются: при XSS это открыло бы канал утечки данных.
 */
export const CSP_DIRECTIVES = Object.freeze({
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:'],
  'media-src': ["'self'", 'blob:', 'mediastream:'],
  'connect-src': ["'self'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'self'"],
  'object-src': ["'none'"],
});

export const PERMISSIONS_POLICY = 'camera=(self), microphone=(self), display-capture=()';

/** Файлы Vite в `assets/` содержат хеш в имени, поэтому кешируются на год без перепроверки. */
const ASSETS_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

const CLIENT_NOT_BUILT = 'Клиент не собран: выполните npm run build';

/**
 * @param {Pick<ServerConfig, 'clientDistDir'>} config
 * @param {Object} deps
 * @param {{ stats(): { rooms: number, participants: number } }} deps.roomManager
 * @param {import('pino').Logger} deps.logger
 * @param {string} [deps.version]
 * @param {() => number} [deps.uptime]  секунды с запуска процесса
 * @returns {import('express').Express}
 */
export function createApp(
  { clientDistDir },
  { roomManager, logger, version = SERVER_VERSION, uptime = () => process.uptime() },
) {
  const app = express();

  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: CSP_DIRECTIVES },
      referrerPolicy: { policy: 'no-referrer' }, // ссылка на комнату не утекает через Referer
      xFrameOptions: { action: 'deny' }, // как frame-ancestors 'none' для старых браузеров
      // Тот же хост и порт работает то по HTTPS (LAN), то по HTTP (localhost в dev и E2E).
      // Запомненный браузером HSTS сломал бы HTTP-режим, а на IP-адресах HSTS не действует.
      strictTransportSecurity: false,
    }),
  );
  app.use((req, res, next) => {
    res.setHeader('Permissions-Policy', PERMISSIONS_POLICY);
    next();
  });

  app.get('/healthz', (req, res) => {
    const { rooms, participants } = roomManager.stats();
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok', rooms, participants, uptimeSec: Math.floor(uptime()), version });
  });

  // Отсутствующий файл в assets — 404, а не index.html под видом скрипта.
  app.use(
    '/assets',
    express.static(join(clientDistDir, 'assets'), {
      immutable: true,
      maxAge: ASSETS_MAX_AGE_MS,
      index: false,
      fallthrough: false,
    }),
  );
  app.use(express.static(clientDistDir, { index: false }));

  // SPA fallback: маршруты клиента (/, /room/:roomId и любые другие) отдают index.html.
  app.get('*', (req, res, next) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(join(clientDistDir, 'index.html'), (error) => {
      if (!error || res.headersSent) return;
      if (error.status === 404) res.status(404).type('text/plain').send(CLIENT_NOT_BUILT);
      else next(error);
    });
  });

  // Без стека и путей в ответе: стандартный обработчик Express показывает их вне production.
  // Ему ошибка передаётся, только если ответ уже начат: он закроет соединение.
  app.use((error, req, res, next) => {
    const status = error.status ?? error.statusCode;
    const code = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500;
    if (code >= 500) logger.error({ err: error, method: req.method, path: req.path }, 'http error');
    if (res.headersSent) return next(error);
    res.status(code).type('text/plain').send(STATUS_CODES[code]);
  });

  return app;
}
