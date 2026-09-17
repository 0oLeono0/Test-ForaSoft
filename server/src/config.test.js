import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAT_HISTORY_LIMIT } from '@vcr/shared';
import { describe, expect, it } from 'vitest';
import { ConfigError, LOG_LEVELS, loadConfig } from './config.js';

const CWD = resolve('/srv/vcr');
const REPO_CLIENT_DIST = fileURLToPath(new URL('../../client/dist', import.meta.url));

function load(env) {
  return loadConfig(env, { cwd: CWD });
}

/** Ошибки конфигурации для `env`; падает, если конфигурация принята. */
function problemsOf(env) {
  try {
    load(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error.problems;
  }
  throw new Error(`конфигурация принята: ${JSON.stringify(env)}`);
}

describe('loadConfig: значения по умолчанию', () => {
  it('совпадают с таблицей TDD §12.3', () => {
    expect(load({})).toEqual({
      port: 3000,
      host: '0.0.0.0',
      ssl: null,
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      chatHistoryLimit: CHAT_HISTORY_LIMIT,
      logLevel: 'info',
      clientDistDir: REPO_CLIENT_DIST,
    });
  });

  it('клиент по умолчанию ищется в client/dist репозитория независимо от cwd', () => {
    expect(loadConfig({}, { cwd: resolve('/elsewhere') }).clientDistDir).toBe(REPO_CLIENT_DIST);
    expect(REPO_CLIENT_DIST).toBe(resolve(fileURLToPath(import.meta.url), '../../../client/dist'));
  });

  it.each(['', '   '])('пустое значение %j равно незаданной переменной', (empty) => {
    const env = Object.fromEntries(
      ['PORT', 'HOST', 'SSL_CERT_PATH', 'SSL_KEY_PATH', 'STUN_URLS', 'CHAT_HISTORY_LIMIT']
        .concat(['LOG_LEVEL', 'CLIENT_DIST_DIR'])
        .map((name) => [name, empty]),
    );

    expect(load(env)).toEqual(load({}));
  });
});

describe('loadConfig: PORT и HOST', () => {
  it.each([
    ['8080', 8080],
    [' 443 ', 443],
    ['0', 0],
    ['65535', 65535],
  ])('PORT=%j → %i', (raw, port) => {
    expect(load({ PORT: raw }).port).toBe(port);
  });

  it.each(['abc', '-1', '65536', '3000.5', '1e3', '0x50', '80 80', '+80'])(
    'PORT=%j — ошибка',
    (raw) => {
      expect(problemsOf({ PORT: raw })).toEqual([
        `PORT: ожидается целое число от 0 до 65535, получено "${raw.trim()}"`,
      ]);
    },
  );

  it('HOST берётся как есть', () => {
    expect(load({ HOST: '127.0.0.1' }).host).toBe('127.0.0.1');
  });
});

describe('loadConfig: SSL', () => {
  it('оба пути заданы — HTTPS, относительные пути разрешаются от cwd', () => {
    const config = load({ SSL_CERT_PATH: 'certs/cert.pem', SSL_KEY_PATH: 'certs/key.pem' });

    expect(config.ssl).toEqual({
      certPath: resolve(CWD, 'certs/cert.pem'),
      keyPath: resolve(CWD, 'certs/key.pem'),
    });
  });

  it('абсолютные пути не меняются', () => {
    const certPath = resolve('/etc/vcr/cert.pem');
    const keyPath = resolve('/etc/vcr/key.pem');

    expect(load({ SSL_CERT_PATH: certPath, SSL_KEY_PATH: keyPath }).ssl).toEqual({
      certPath,
      keyPath,
    });
  });

  it('задан только SSL_CERT_PATH — ошибка про SSL_KEY_PATH', () => {
    expect(problemsOf({ SSL_CERT_PATH: 'certs/cert.pem' })).toEqual([
      'SSL_KEY_PATH: не задана, а для HTTPS нужна вместе с SSL_CERT_PATH',
    ]);
  });

  it('задан только SSL_KEY_PATH — ошибка про SSL_CERT_PATH', () => {
    expect(problemsOf({ SSL_KEY_PATH: 'certs/key.pem', SSL_CERT_PATH: ' ' })).toEqual([
      'SSL_CERT_PATH: не задана, а для HTTPS нужна вместе с SSL_KEY_PATH',
    ]);
  });
});

describe('loadConfig: STUN_URLS', () => {
  it('один адрес → один RTCIceServer', () => {
    expect(load({ STUN_URLS: 'stun:192.168.1.10:3478' }).iceServers).toEqual([
      { urls: 'stun:192.168.1.10:3478' },
    ]);
  });

  it('список через запятую: пробелы и пустые элементы отбрасываются, порядок сохраняется', () => {
    const { iceServers } = load({
      STUN_URLS: ' stun:stun.l.google.com:19302 ,, stuns:stun.example.org:5349,STUN:[::1]:3478,',
    });

    expect(iceServers).toEqual([
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stuns:stun.example.org:5349' },
      { urls: 'STUN:[::1]:3478' },
    ]);
  });

  it.each([
    'turn:turn.example.org:3478',
    'stun.l.google.com:19302',
    'http://stun.example.org',
    'stun:',
    'stun:host name',
    'stun:ok.example.org, turn:bad.example.org',
    ',',
    ' , ',
  ])('STUN_URLS=%j — ошибка', (raw) => {
    expect(problemsOf({ STUN_URLS: raw })).toEqual([
      `STUN_URLS: ожидается список адресов вида stun:host:port через запятую, получено "${raw.trim()}"`,
    ]);
  });
});

describe('loadConfig: CHAT_HISTORY_LIMIT, LOG_LEVEL, CLIENT_DIST_DIR', () => {
  it.each([
    ['1', 1],
    ['500', 500],
  ])('CHAT_HISTORY_LIMIT=%j → %i', (raw, limit) => {
    expect(load({ CHAT_HISTORY_LIMIT: raw }).chatHistoryLimit).toBe(limit);
  });

  it.each(['0', '-5', '2.5', 'many', '9007199254740992'])(
    'CHAT_HISTORY_LIMIT=%j — ошибка',
    (raw) => {
      expect(problemsOf({ CHAT_HISTORY_LIMIT: raw })).toEqual([
        `CHAT_HISTORY_LIMIT: ожидается целое число не меньше 1, получено "${raw}"`,
      ]);
    },
  );

  it.each(LOG_LEVELS)('LOG_LEVEL=%s принимается', (level) => {
    expect(load({ LOG_LEVEL: level }).logLevel).toBe(level);
  });

  it('LOG_LEVEL без учёта регистра', () => {
    expect(load({ LOG_LEVEL: 'DEBUG' }).logLevel).toBe('debug');
  });

  it('неизвестный LOG_LEVEL — ошибка со списком допустимых значений', () => {
    expect(problemsOf({ LOG_LEVEL: 'verbose' })).toEqual([
      'LOG_LEVEL: ожидается одно из значений fatal, error, warn, info, debug, trace, silent, получено "verbose"',
    ]);
  });

  it('CLIENT_DIST_DIR разрешается от cwd', () => {
    expect(load({ CLIENT_DIST_DIR: 'public' }).clientDistDir).toBe(resolve(CWD, 'public'));
  });
});

describe('loadConfig: результат и ошибки', () => {
  it('объект конфигурации заморожен вместе с вложенными', () => {
    const config = load({ SSL_CERT_PATH: 'c.pem', SSL_KEY_PATH: 'k.pem' });

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.ssl)).toBe(true);
    expect(Object.isFrozen(config.iceServers)).toBe(true);
    expect(Object.isFrozen(config.iceServers[0])).toBe(true);
  });

  it('все ошибки перечисляются сразу, по строке на переменную', () => {
    const env = {
      PORT: 'http',
      SSL_KEY_PATH: 'key.pem',
      STUN_URLS: 'turn:x',
      CHAT_HISTORY_LIMIT: '0',
      LOG_LEVEL: 'loud',
    };

    let error;
    try {
      load(env);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ConfigError);
    expect(error.name).toBe('ConfigError');
    expect(error.problems.map((problem) => problem.split(':')[0])).toEqual([
      'PORT',
      'SSL_CERT_PATH',
      'STUN_URLS',
      'CHAT_HISTORY_LIMIT',
      'LOG_LEVEL',
    ]);
    expect(error.message).toBe(
      `Некорректная конфигурация сервера:\n${error.problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  });

  it('без аргументов читает process.env и process.cwd(); переданный env с ними не смешивается', () => {
    const previous = { PORT: process.env.PORT, CLIENT_DIST_DIR: process.env.CLIENT_DIST_DIR };
    process.env.PORT = '4321';
    process.env.CLIENT_DIST_DIR = 'dist-from-env';
    try {
      expect(loadConfig()).toMatchObject({
        port: 4321,
        clientDistDir: resolve(process.cwd(), 'dist-from-env'),
      });
      expect(load({}).port).toBe(3000);
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
