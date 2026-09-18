// Проверка самой оснастки E2E (TDD §11.4): тестовая сборка отдаёт дев-хук, prod-like сервер
// поднимается, участники в разных контекстах доходят до комнаты и до P2P-соединения.
// Продуктовые сценарии E-1…E-10 живут в отдельных файлах.
import { expect, test } from '@playwright/test';
import {
  closeParticipants,
  createParticipant,
  createRoom,
  joinRoom,
  waitForPeerConnected,
} from './support/room.js';

test('prod-like сервер отдаёт собранный клиент', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Видеочат-комната' })).toBeVisible();
});

test('двое участников доходят до комнаты и соединяются', async ({ browser }) => {
  const alice = await createParticipant(browser, 'Алиса');
  const bob = await createParticipant(browser, 'Борис');

  try {
    const roomUrl = await createRoom(alice);
    await joinRoom(bob, roomUrl);

    // Хук появляется только на странице комнаты: на главной сессии ещё нет.
    await expect.poll(() => alice.page.evaluate(() => typeof window.__vcr)).toBe('object');

    await waitForPeerConnected(alice.page, 1);
    await waitForPeerConnected(bob.page, 1);
  } finally {
    await closeParticipants(alice, bob);
  }
});
