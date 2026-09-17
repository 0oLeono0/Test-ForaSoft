// Конфигурация сервера из переменных окружения (TDD §12.3): значения по умолчанию, разбор и
// проверка. Все ошибки собираются в одно исключение, чтобы исправить конфигурацию за один запуск.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAT_HISTORY_LIMIT } from '@vcr/shared';

/** Уровни pino, которые принимает `LOG_LEVEL`. */
export const LOG_LEVELS = Object.freeze([
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
]);

/** Публичный STUN Google (PRD §7). */
export const DEFAULT_STUN_URLS = 'stun:stun.l.google.com:19302';

/** `client/dist` рядом с пакетом server, из какого бы каталога ни запускался процесс. */
const DEFAULT_CLIENT_DIST_DIR = fileURLToPath(new URL('../../client/dist', import.meta.url));

const PORT_MAX = 65_535;

/** TURN не используется (PRD §7), поэтому принимаются только схемы `stun:` и `stuns:`. */
const STUN_URL_PATTERN = /^stuns?:[^\s/?#]+$/i;

/**
 * @typedef {Object} ServerConfig
 * @property {number} port
 * @property {string} host
 * @property {{ certPath: string, keyPath: string } | null} ssl  // null — HTTP (только для localhost)
 * @property {RTCIceServer[]} iceServers  // по `{ urls }` на адрес; клиент получает их в ack room:join
 * @property {number} chatHistoryLimit
 * @property {string} logLevel
 * @property {string} clientDistDir       // абсолютный путь к собранному клиенту
 */

export class ConfigError extends Error {
  /** @param {string[]} problems  по одной строке на переменную */
  constructor(problems) {
    super(`Некорректная конфигурация сервера:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * Читает конфигурацию из переменных окружения. Пробелы по краям значения отбрасываются, пустое
 * значение равно незаданной переменной. Относительные пути разрешаются от `cwd`.
 * @param {Record<string, string | undefined>} [env]
 * @param {{ cwd?: string }} [options]
 * @returns {Readonly<ServerConfig>}  замороженный объект вместе с вложенными
 * @throws {ConfigError}  если хотя бы одно значение некорректно
 */
export function loadConfig(env = process.env, { cwd = process.cwd() } = {}) {
  const problems = [];
  const read = (name) => env[name]?.trim() || undefined;

  /** Разбирает значение или значение по умолчанию; `null` от `parser` — ошибка в `problems`. */
  const parse = (name, defaultValue, parser, expected) => {
    const raw = read(name);
    const value = parser(raw ?? defaultValue);
    if (value === null) problems.push(`${name}: ожидается ${expected}, получено "${raw}"`);
    return value;
  };

  const config = Object.freeze({
    port: parse(
      'PORT',
      '3000',
      (raw) => parseInteger(raw, 0, PORT_MAX),
      `целое число от 0 до ${PORT_MAX}`,
    ),
    host: read('HOST') ?? '0.0.0.0',
    ssl: parseSsl(read('SSL_CERT_PATH'), read('SSL_KEY_PATH'), cwd, problems),
    iceServers: parse(
      'STUN_URLS',
      DEFAULT_STUN_URLS,
      parseStunUrls,
      'список адресов вида stun:host:port через запятую',
    ),
    chatHistoryLimit: parse(
      'CHAT_HISTORY_LIMIT',
      String(CHAT_HISTORY_LIMIT),
      (raw) => parseInteger(raw, 1, Number.MAX_SAFE_INTEGER),
      'целое число не меньше 1',
    ),
    logLevel: parse(
      'LOG_LEVEL',
      'info',
      (raw) => (LOG_LEVELS.includes(raw.toLowerCase()) ? raw.toLowerCase() : null),
      `одно из значений ${LOG_LEVELS.join(', ')}`,
    ),
    clientDistDir: resolve(cwd, read('CLIENT_DIST_DIR') ?? DEFAULT_CLIENT_DIST_DIR),
  });

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

/** Десятичное целое без знака и экспоненты в диапазоне `[min, max]` или `null`. */
function parseInteger(raw, min, max) {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

/** Пути к сертификату и ключу задаются только вместе: иначе HTTPS не поднять. */
function parseSsl(certPath, keyPath, cwd, problems) {
  if (certPath === undefined && keyPath === undefined) return null;
  if (certPath === undefined || keyPath === undefined) {
    const [present, missing] = certPath
      ? ['SSL_CERT_PATH', 'SSL_KEY_PATH']
      : ['SSL_KEY_PATH', 'SSL_CERT_PATH'];
    problems.push(`${missing}: не задана, а для HTTPS нужна вместе с ${present}`);
    return null;
  }
  return Object.freeze({ certPath: resolve(cwd, certPath), keyPath: resolve(cwd, keyPath) });
}

/** Адреса через запятую → `[{ urls }]`; пустые элементы пропускаются. */
function parseStunUrls(raw) {
  const urls = raw
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
  if (urls.length === 0 || !urls.every((url) => STUN_URL_PATTERN.test(url))) return null;
  return Object.freeze(urls.map((url) => Object.freeze({ urls: url })));
}
