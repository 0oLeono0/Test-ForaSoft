// Хелперы E2E (TDD §11.4): участник = отдельный браузерный контекст, вход в комнату и ожидание
// установленных P2P-соединений через дев-хук `window.__vcr`.
import { expect } from '@playwright/test';

/** Адрес комнаты после «Создать комнату»: идентификатор генерирует клиент (TDD §3.4). */
export const ROOM_URL_PATTERN = /\/room\/[A-Za-z0-9_-]+$/;

/**
 * Сколько ждём `connected` у пары. С запасом к таймауту `PeerLink` (15 с, FR-34): на localhost
 * согласование занимает доли секунды, но фейковые устройства под нагрузкой бывают медленными.
 */
export const PEER_CONNECT_TIMEOUT_MS = 20_000;

/**
 * @typedef {Object} Participant
 * @property {string} name
 * @property {import('@playwright/test').BrowserContext} context
 * @property {import('@playwright/test').Page} page
 */

/**
 * Отдельный контекст на участника: свои cookie, своё хранилище и свой набор разрешений — так
 * вкладки не делят состояние, как не делят его разные люди (TDD §11.4).
 * @param {import('@playwright/test').Browser} browser
 * @param {string} name  отображаемое имя, оно же подпись плитки
 * @returns {Promise<Participant>}
 */
export async function createParticipant(browser, name) {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { name, context, page };
}

/**
 * Закрывает контексты: иначе сокеты доживут до конца воркера и займут слоты в комнате (FR-7).
 * @param {...Participant} participants
 */
export async function closeParticipants(...participants) {
  await Promise.all(participants.map(({ context }) => context.close()));
}

/**
 * Заполняет форму имени и отправляет её. Форма одна и та же на главной и на экране входа,
 * различается только подпись кнопки (FR-1, FR-4).
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} submitLabel  «Создать комнату» или «Войти»
 */
export async function submitName(page, name, submitLabel) {
  await page.getByLabel('Ваше имя').fill(name);
  await page.getByRole('button', { name: submitLabel }).click();
}

/**
 * Ждёт саму комнату: панель управления есть только в фазе `inRoom` (TDD §4.1.2).
 * @param {import('@playwright/test').Page} page
 */
export async function waitForInRoom(page) {
  await expect(page.getByRole('button', { name: 'Выйти' })).toBeVisible();
}

/**
 * Создаёт комнату с главной страницы (US-1, US-2).
 * @param {Participant} participant
 * @returns {Promise<string>} ссылка-приглашение: её и раздают остальным (FR-3)
 */
export async function createRoom({ page, name }) {
  await page.goto('/');
  await submitName(page, name, 'Создать комнату');
  await expect(page).toHaveURL(ROOM_URL_PATTERN);
  await waitForInRoom(page);
  return page.url();
}

/**
 * Вход по ссылке-приглашению с вводом имени (US-4). Для сценариев, где вход не должен удаться
 * («Комната заполнена»), нужен не этот хелпер, а `page.goto` и `submitName` по отдельности.
 * @param {Participant} participant
 * @param {string} url  адрес комнаты
 */
export async function joinRoom({ page, name }, url) {
  await page.goto(url);
  await submitName(page, name, 'Войти');
  await waitForInRoom(page);
}

/**
 * Ждёт, пока у страницы будет не меньше `count` установленных соединений с участниками.
 *
 * Статусы читаются из дев-хука `window.__vcr` (есть только в сборке `--mode test`): заглянуть
 * внутрь `RTCPeerConnection` из Playwright нельзя, а ждать «картинка поехала» по пикселям долго
 * и ненадёжно (TDD §11.4). Себя в `links` нет — там только пары.
 * @param {import('@playwright/test').Page} page
 * @param {number} count
 */
export async function waitForPeerConnected(page, count) {
  await page.waitForFunction(
    (expected) => {
      const links = window.__vcr?.links ?? {};
      return Object.values(links).filter((status) => status === 'connected').length >= expected;
    },
    count,
    { timeout: PEER_CONNECT_TIMEOUT_MS },
  );
}

/**
 * Состояние локальных дорожек участника из того же хука: `readyState === 'ended'` доказывает,
 * что выключенная камера освободила устройство (FR-19).
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<Record<string, { readyState: string, enabled: boolean }|null>>}
 */
export function localTracks(page) {
  return page.evaluate(() => window.__vcr.local);
}

/**
 * Плитки участников в сетке (FR-11). Своя плитка отмечена модификатором `--self` (TDD §4.1.5).
 * @param {import('@playwright/test').Page} page
 */
export function tiles(page) {
  return page.locator('.video-tile');
}

/**
 * Плитка по подписи в оверлее; своя подписана «имя (Вы)», поэтому подходит и для себя,
 * и для собеседника.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
export function tileOf(page, name) {
  return tiles(page).filter({ has: page.locator('.video-tile__name', { hasText: name }) });
}

/**
 * Ширина кадра в `<video>` участника: больше нуля — по соединению действительно идёт видео,
 * а не только состояние `connected` (US-6).
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @returns {Promise<number>}
 */
export function videoWidthOf(page, name) {
  return tileOf(page, name)
    .locator('video')
    .evaluate((video) => video.videoWidth);
}
