// E-4 и E-5 из TDD §11.4: тумблеры устройств у собеседника и чат с историей.
import { expect, test } from '@playwright/test';
import {
  closeParticipants,
  createParticipant,
  createRoom,
  joinRoom,
  localTracks,
  tileOf,
  waitForPeerConnected,
} from './support/room.js';

/** Сообщение с разметкой: в ленте оно должно остаться текстом (FR-39, TDD §10.3). */
const HTML_MESSAGE = '<img src=x onerror=alert(1)>';

test('E-4: выключенные микрофон и камера видны собеседнику, устройство освобождается', async ({
  browser,
}) => {
  const alice = await createParticipant(browser, 'Алиса');
  const bob = await createParticipant(browser, 'Борис');

  try {
    const roomUrl = await createRoom(alice);
    await joinRoom(bob, roomUrl);
    await waitForPeerConnected(alice.page, 1);
    await waitForPeerConnected(bob.page, 1);

    const aliceTileForBob = tileOf(bob.page, 'Алиса');
    // До тумблеров устройства включены: иначе проверки ниже ничего не доказывают (FR-14).
    await expect(aliceTileForBob.getByRole('img', { name: 'Микрофон выключен' })).toBeHidden();

    await alice.page.getByRole('button', { name: 'Микрофон' }).click();
    // Состояние едет через media:state, а не через пропажу звука в дорожке (FR-15, FR-16).
    await expect(aliceTileForBob.getByRole('img', { name: 'Микрофон выключен' })).toBeVisible();
    // Дорожка микрофона остаётся живой: выключение — это enabled = false (TDD §7.4).
    await expect
      .poll(async () => (await localTracks(alice.page)).audio)
      .toMatchObject({
        readyState: 'live',
        enabled: false,
      });

    await alice.page.getByRole('button', { name: 'Камера' }).click();
    // Вместо видео у собеседника силуэт (FR-18, US-12).
    await expect(aliceTileForBob.locator('.video-tile__placeholder')).toBeVisible();
    // Камера выключается через stop(): только так гаснет аппаратный индикатор (FR-19, US-7).
    await expect.poll(async () => (await localTracks(alice.page)).video?.readyState).toBe('ended');
  } finally {
    await closeParticipants(alice, bob);
  }
});

test('E-5: сообщение с разметкой приходит текстом, со временем и остаётся в истории', async ({
  browser,
}) => {
  const alice = await createParticipant(browser, 'Алиса');
  const bob = await createParticipant(browser, 'Борис');
  const carol = await createParticipant(browser, 'Вера');

  try {
    const roomUrl = await createRoom(alice);
    await joinRoom(bob, roomUrl);

    await alice.page.getByLabel('Сообщение').fill(HTML_MESSAGE);
    await alice.page.getByRole('button', { name: 'Отправить' }).click();

    for (const { page } of [alice, bob]) {
      // Разметка видна как текст, и в ленте не появилось ни одного элемента из неё (FR-39).
      await expect(page.getByText(HTML_MESSAGE)).toBeVisible();
      await expect(page.locator('.message-list img')).toHaveCount(0);
      await expect(page.locator('.message__author').last()).toHaveText('Алиса');
      // Время — HH:MM в часовом поясе читателя (FR-22).
      await expect(page.locator('.message__time').last()).toHaveText(/^\d{2}:\d{2}$/);
    }

    // Вошедший позже получает историю в ack room:join (FR-23, US-8).
    await joinRoom(carol, roomUrl);
    await expect(carol.page.getByText(HTML_MESSAGE)).toBeVisible();
    await expect(carol.page.getByText('Борис присоединился(-ась)')).toBeVisible();
  } finally {
    await closeParticipants(alice, bob, carol);
  }
});
