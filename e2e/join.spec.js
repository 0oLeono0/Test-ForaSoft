// E-1, E-2, E-10 из TDD §11.4: создание комнаты, вход по ссылке, проверка имени и перезагрузка.
import { expect, test } from '@playwright/test';
import {
  ROOM_URL_PATTERN,
  closeParticipants,
  createParticipant,
  createRoom,
  joinRoom,
  submitName,
  tileOf,
  tiles,
  videoWidthOf,
  waitForPeerConnected,
} from './support/room.js';

test('E-1: A создаёт комнату и копирует ссылку, B входит по ней и видит видео', async ({
  browser,
}) => {
  const alice = await createParticipant(browser, 'Алиса');
  const bob = await createParticipant(browser, 'Борис');

  try {
    const roomUrl = await createRoom(alice);
    expect(roomUrl).toMatch(ROOM_URL_PATTERN);

    // Содержимое буфера не читается: в headless он один на браузер и в параллельных прогонах
    // не изолирован. Что ссылка верна, доказывает вход B по возвращённому адресу (FR-3, US-3).
    await alice.page.getByRole('button', { name: 'Скопировать ссылку' }).click();
    await expect(alice.page.getByText('Ссылка скопирована')).toBeVisible();

    await joinRoom(bob, roomUrl);
    await waitForPeerConnected(alice.page, 1);
    await waitForPeerConnected(bob.page, 1);

    // По две плитки у каждого: своя и собеседника, обе подписаны именами (FR-11, FR-12).
    await expect(tiles(alice.page)).toHaveCount(2);
    await expect(tiles(bob.page)).toHaveCount(2);
    await expect(tileOf(alice.page, 'Алиса (Вы)')).toBeVisible();
    await expect(tileOf(alice.page, 'Борис')).toBeVisible();
    await expect(tileOf(bob.page, 'Борис (Вы)')).toBeVisible();
    await expect(tileOf(bob.page, 'Алиса')).toBeVisible();

    // Кадр у удалённого участника не нулевой ширины: видео дошло, а не только SDP (US-6).
    await expect.poll(() => videoWidthOf(alice.page, 'Борис')).toBeGreaterThan(0);
    await expect.poll(() => videoWidthOf(bob.page, 'Алиса')).toBeGreaterThan(0);
  } finally {
    await closeParticipants(alice, bob);
  }
});

test('E-2: пустое имя не пускает в комнату', async ({ browser }) => {
  const alice = await createParticipant(browser, 'Алиса');

  try {
    const { page } = alice;
    await page.goto('/');

    await page.getByRole('button', { name: 'Создать комнату' }).click();
    await expect(page.getByRole('alert')).toHaveText('Введите имя');
    expect(new URL(page.url()).pathname).toBe('/');

    // Имя из одних пробелов — то же самое: сервер и клиент считают его пустым (FR-1, TDD §4.3).
    await submitName(page, '   ', 'Создать комнату');
    await expect(page.getByRole('alert')).toHaveText('Введите имя');
    expect(new URL(page.url()).pathname).toBe('/');
  } finally {
    await closeParticipants(alice);
  }
});

test('E-10: перезагрузка возвращает к форме имени, остальные видят выход', async ({ browser }) => {
  const alice = await createParticipant(browser, 'Алиса');
  const bob = await createParticipant(browser, 'Борис');

  try {
    const roomUrl = await createRoom(alice);
    await joinRoom(bob, roomUrl);
    await expect(tiles(alice.page)).toHaveCount(2);

    await bob.page.reload();

    // Имя живёт только в памяти загрузки SPA (TDD §5.4): после перезагрузки его вводят заново.
    await expect(bob.page.getByLabel('Ваше имя')).toBeVisible();
    await expect(bob.page.getByRole('button', { name: 'Войти' })).toBeVisible();

    // Для остальных перезагрузка неотличима от выхода (FR-28, US-10).
    await expect(tiles(alice.page)).toHaveCount(1);
    await expect(alice.page.getByText('Борис покинул(а) комнату')).toBeVisible();
  } finally {
    await closeParticipants(alice, bob);
  }
});
