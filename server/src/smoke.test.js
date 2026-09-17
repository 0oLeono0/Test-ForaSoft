import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { MAX_PARTICIPANTS } from '@vcr/shared';
import { describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url));

/** Окружение дочернего процесса: переменные сервера из окружения теста не наследуются. */
function serverEnv(overrides) {
  const cleared = Object.fromEntries(
    ['SSL_CERT_PATH', 'SSL_KEY_PATH', 'STUN_URLS', 'CHAT_HISTORY_LIMIT', 'CLIENT_DIST_DIR'].map(
      (name) => [name, ''],
    ),
  );
  return { ...process.env, ...cleared, HOST: '127.0.0.1', PORT: '0', ...overrides };
}

/** Порт из JSON-записи `server listening` в stdout процесса. */
function waitForListening(child, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('сервер не запустился')), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const record = JSON.parse(line);
        if (record.msg === 'server listening') {
          clearTimeout(timer);
          resolve(record.port);
        }
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`процесс завершился с кодом ${code}`));
    });
  });
}

describe('server: тестовый раннер', () => {
  it('выполняется в Node.js не ниже 20 (engines)', () => {
    const major = Number(process.versions.node.split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(20);
    expect(typeof document).toBe('undefined');
  });

  it('импортирует @vcr/shared через Vitest', () => {
    expect(MAX_PARTICIPANTS).toBe(4);
  });
});

describe('server: точка входа в Node', () => {
  it('node server/src/index.js запускает сервер с @vcr/shared: /healthz отвечает', async () => {
    const child = spawn(process.execPath, [ENTRY], {
      env: serverEnv({ LOG_LEVEL: 'info' }),
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    try {
      const port = await waitForListening(child);
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'ok', rooms: 0, participants: 0 });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
  }, 15_000);

  it('импорт модуля сервер не запускает: процесс сразу завершается', async () => {
    const script = `await import(${JSON.stringify(pathToFileURL(ENTRY).href)}); console.log('imported');`;

    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', script],
      { env: serverEnv({ LOG_LEVEL: 'info' }), timeout: 10_000 },
    );

    expect(stdout).toBe('imported\n');
  }, 15_000);

  it('некорректная конфигурация: сообщение в stderr и код выхода 1', async () => {
    const run = promisify(execFile)(process.execPath, [ENTRY], {
      env: serverEnv({ PORT: 'http', LOG_LEVEL: 'loud' }),
    });

    await expect(run).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringMatching(
        /^Некорректная конфигурация сервера:\n {2}- PORT: .*\n {2}- LOG_LEVEL: .*\n$/,
      ),
    });
  });
});
