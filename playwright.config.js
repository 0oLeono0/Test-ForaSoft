// Конфигурация E2E (TDD §11.4, §12.1). Один Chromium с фейковыми камерой и микрофоном, один
// prod-like сервер на localhost: `localhost` — защищённый контекст, поэтому HTTPS и сертификаты
// для тестов не нужны, а getUserMedia работает.
import { defineConfig } from '@playwright/test';

/** Порт prod-like сервера (TDD §12.3). */
const PORT = 3000;

const BASE_URL = `http://localhost:${PORT}`;

/**
 * Фейковые устройства Chromium: `--use-fake-device-for-media-stream` подставляет тестовый
 * сигнал вместо камеры и микрофона, `--use-fake-ui-for-media-stream` принимает запрос
 * разрешений без диалога — иначе getUserMedia не завершился бы никогда (TDD §11.4).
 */
const FAKE_MEDIA_ARGS = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];

export default defineConfig({
  testDir: './e2e',
  // Сценарий поднимает до пяти браузерных контекстов с медиа, поэтому внутри файла тесты идут
  // подряд; файлы друг другу не мешают — у каждого теста своя комната со своим идентификатором.
  fullyParallel: false,
  workers: process.env.CI ? 1 : undefined,
  forbidOnly: Boolean(process.env.CI),
  // Согласование WebRTC и фейковые устройства изредка тормозят: одна повторная попытка отделяет
  // мигающий тест от настоящего падения (TDD §11.4).
  retries: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    browserName: 'chromium',
    // Минимальная ширина макета из PRD §6 — 1024px; берём чуть больше рабочего минимума.
    viewport: { width: 1280, height: 800 },
    launchOptions: { args: FAKE_MEDIA_ARGS },
    // Трасса пишется всегда, но сохраняется только у упавшего теста — включая первую попытку.
    trace: 'retain-on-failure',
  },
  webServer: {
    // Сборка в режиме test добавляет дев-хук window.__vcr, по которому E2E видит статусы пар
    // (TDD §11.4); сервер отдаёт эту сборку и обслуживает сигналинг (TDD §12.1).
    command: 'npm run build:test && npm start',
    url: `${BASE_URL}/healthz`,
    // Чужой сервер на этом порту переиспользовать нельзя: в нём может не быть тестовой сборки.
    reuseExistingServer: false,
    env: { PORT: String(PORT) },
    timeout: 120_000,
  },
});
