import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { RoomManager } from '../rooms/RoomManager.js';
import { CSP_DIRECTIVES, PERMISSIONS_POLICY, SERVER_VERSION, createApp } from './app.js';

const INDEX_HTML = '<!doctype html><title>Видеочат</title><div id="root"></div>';
const ASSET_JS = 'console.log("app");';

let distDir;

beforeAll(() => {
  distDir = mkdtempSync(join(tmpdir(), 'vcr-dist-'));
  mkdirSync(join(distDir, 'assets'));
  writeFileSync(join(distDir, 'index.html'), INDEX_HTML);
  writeFileSync(join(distDir, 'assets', 'index-B1a2c3d4.js'), ASSET_JS);
  writeFileSync(join(distDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
});

afterAll(() => {
  rmSync(distDir, { recursive: true, force: true });
});

function fakeLogger() {
  return { error: vi.fn() };
}

function makeApp({ clientDistDir = distDir, ...deps } = {}) {
  return createApp(
    { clientDistDir },
    { roomManager: new RoomManager(), logger: fakeLogger(), ...deps },
  );
}

/** Разбирает CSP в `{ директива: [источники] }`. */
function parseCsp(header) {
  return Object.fromEntries(
    header
      .split(';')
      .map((directive) => directive.trim())
      .filter(Boolean)
      .map((directive) => {
        const [name, ...sources] = directive.split(/\s+/);
        return [name, sources];
      }),
  );
}

describe('createApp: заголовки безопасности', () => {
  it('CSP в точности совпадает с TDD §10.3', async () => {
    const response = await request(makeApp()).get('/');

    expect(parseCsp(response.headers['content-security-policy'])).toEqual({
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
    expect(CSP_DIRECTIVES).toEqual(parseCsp(response.headers['content-security-policy']));
  });

  it.each([
    ['index.html', '/room/abc123'],
    ['статика', '/assets/index-B1a2c3d4.js'],
    ['/healthz', '/healthz'],
    ['404 статики', '/assets/missing.js'],
  ])('%s: Permissions-Policy, Referrer-Policy и защита от фреймов', async (_, path) => {
    const response = await request(makeApp()).get(path);

    expect(response.headers['permissions-policy']).toBe(
      'camera=(self), microphone=(self), display-capture=()',
    );
    expect(PERMISSIONS_POLICY).toBe(response.headers['permissions-policy']);
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(response.headers).not.toHaveProperty('x-powered-by');
    expect(response.headers).not.toHaveProperty('strict-transport-security');
  });
});

describe('createApp: /healthz', () => {
  it('возвращает статус, счётчики комнат и участников, uptime и версию', async () => {
    const roomManager = new RoomManager();
    for (const [roomId, name] of [
      ['room-a', 'Мария'],
      ['room-a', 'Алекс'],
      ['room-b', 'Пётр'],
    ]) {
      roomManager.join({ roomId, name, socketId: `socket-${name}` });
    }

    const response = await request(makeApp({ roomManager, uptime: () => 1234.9 })).get('/healthz');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      status: 'ok',
      rooms: 2,
      participants: 3,
      uptimeSec: 1234,
      version: SERVER_VERSION,
    });
  });

  it('счётчики актуальны на момент запроса', async () => {
    const roomManager = new RoomManager();
    const app = makeApp({ roomManager });

    expect((await request(app).get('/healthz')).body).toMatchObject({ rooms: 0, participants: 0 });

    const { participant } = roomManager.join({ roomId: 'r', name: 'Мария', socketId: 's' });
    expect((await request(app).get('/healthz')).body).toMatchObject({ rooms: 1, participants: 1 });

    roomManager.leave(participant.id);
    expect((await request(app).get('/healthz')).body).toMatchObject({ rooms: 0, participants: 0 });
  });

  it('по умолчанию uptime процесса и версия из server/package.json', async () => {
    const response = await request(makeApp()).get('/healthz');
    const { version } = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    );

    expect(response.body.version).toBe(version);
    expect(Number.isInteger(response.body.uptimeSec)).toBe(true);
    expect(response.body.uptimeSec).toBeLessThanOrEqual(Math.ceil(process.uptime()));
    expect(response.body.uptimeSec).toBeGreaterThanOrEqual(0);
  });
});

describe('createApp: статика и SPA fallback', () => {
  it.each(['/', '/room/abc123', '/room/V1StGXR8_Z', '/unknown/deep/path?x=1'])(
    'GET %s → index.html без долгого кеша',
    async (path) => {
      const response = await request(makeApp()).get(path);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/html/);
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.text).toBe(INDEX_HTML);
    },
  );

  it('HEAD /room/abc123 → 200 text/html', async () => {
    const response = await request(makeApp()).head('/room/abc123');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
  });

  it('файлы из assets кешируются на год как immutable', async () => {
    const response = await request(makeApp()).get('/assets/index-B1a2c3d4.js');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(response.text).toBe(ASSET_JS);
  });

  it('отсутствующий файл в assets → 404, а не index.html', async () => {
    const response = await request(makeApp()).get('/assets/missing-0000.js');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/^text\/plain/);
    expect(response.text).toBe('Not Found');
  });

  it('прочие файлы из корня сборки отдаются как есть', async () => {
    const response = await request(makeApp()).get('/favicon.svg');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^image\/svg\+xml/);
  });

  it('fallback только для GET: POST /room/abc123 → 404', async () => {
    const response = await request(makeApp()).post('/room/abc123');

    expect(response.status).toBe(404);
    expect(response.text).not.toBe(INDEX_HTML);
  });

  it('клиент не собран: понятный 404, /healthz работает', async () => {
    const app = makeApp({ clientDistDir: join(distDir, 'not-built') });

    const page = await request(app).get('/room/abc123');
    expect(page.status).toBe(404);
    expect(page.headers['content-type']).toMatch(/^text\/plain/);
    expect(page.text).toBe('Клиент не собран: выполните npm run build');

    expect((await request(app).get('/healthz')).status).toBe(200);
  });
});

describe('createApp: ошибки', () => {
  it('исключение в обработчике → 500 без стека, ошибка в логе', async () => {
    const logger = fakeLogger();
    const error = new Error('stats failed at /secret/path');
    const roomManager = {
      stats: () => {
        throw error;
      },
    };

    const response = await request(makeApp({ roomManager, logger })).get('/healthz');

    expect(response.status).toBe(500);
    expect(response.headers['content-type']).toMatch(/^text\/plain/);
    expect(response.text).toBe('Internal Server Error');
    expect(logger.error).toHaveBeenCalledWith(
      { err: error, method: 'GET', path: '/healthz' },
      'http error',
    );
  });

  it('ошибка клиента (некорректный путь) не пишется в лог как сбой', async () => {
    const logger = fakeLogger();

    const response = await request(makeApp({ logger })).get('/assets/%E0%A4%A');

    expect(response.status).toBe(400);
    expect(response.text).toBe('Bad Request');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('index.html не читается (не файл) → 500 без подробностей, ошибка в логе', async () => {
    const brokenDist = join(distDir, 'broken');
    mkdirSync(join(brokenDist, 'index.html'), { recursive: true });
    const logger = fakeLogger();

    const response = await request(makeApp({ clientDistDir: brokenDist, logger })).get('/room/x');

    expect(response.status).toBe(500);
    expect(response.text).toBe('Internal Server Error');
    expect(response.text).not.toContain(brokenDist);
    expect(logger.error).toHaveBeenCalledWith(
      { err: expect.any(Error), method: 'GET', path: '/room/x' },
      'http error',
    );
  });
});
