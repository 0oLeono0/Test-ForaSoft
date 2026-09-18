// E-3 и E-6 из TDD §11.4: лимит в четыре участника и освобождение слота при выходе.
import { expect, test } from '@playwright/test';
import {
  closeParticipants,
  createParticipant,
  createRoom,
  joinRoom,
  submitName,
  tiles,
  waitForInRoom,
} from './support/room.js';

test('E-3: пятый участник видит «Комната заполнена» и входит после выхода одного', async ({
  browser,
}) => {
  const names = ['Алиса', 'Борис', 'Вера', 'Глеб'];
  const members = await Promise.all(names.map((name) => createParticipant(browser, name)));
  const latecomer = await createParticipant(browser, 'Дина');

  try {
    const [host, ...guests] = members;
    const roomUrl = await createRoom(host);
    // По одному: одновременный вход — это отдельный сценарий гонки (I-3, интеграционные тесты).
    for (const guest of guests) await joinRoom(guest, roomUrl);
    await expect(tiles(host.page)).toHaveCount(4);

    await latecomer.page.goto(roomUrl);
    await submitName(latecomer.page, latecomer.name, 'Войти');
    await expect(latecomer.page.getByRole('heading', { name: 'Комната заполнена' })).toBeVisible();

    // Слот освобождается сразу после выхода — «Повторить вход» тем же экраном (FR-8, US-5).
    await members[3].page.getByRole('button', { name: 'Выйти' }).click();
    await expect(tiles(host.page)).toHaveCount(3);

    await latecomer.page.getByRole('button', { name: 'Повторить вход' }).click();
    await waitForInRoom(latecomer.page);
    await expect(tiles(latecomer.page)).toHaveCount(4);
    await expect(tiles(host.page)).toHaveCount(4);
  } finally {
    await closeParticipants(...members, latecomer);
  }
});

test('E-6: выход по кнопке и закрытие вкладки убирают плитку у остальных', async ({ browser }) => {
  const alice = await createParticipant(browser, 'Алиса');
  const bob = await createParticipant(browser, 'Борис');
  const carol = await createParticipant(browser, 'Вера');

  try {
    const roomUrl = await createRoom(alice);
    await joinRoom(bob, roomUrl);
    await joinRoom(carol, roomUrl);
    await expect(tiles(alice.page)).toHaveCount(3);

    await bob.page.getByRole('button', { name: 'Выйти' }).click();
    // Вышедший возвращается на главную (FR-27, TDD §7.6).
    await expect(bob.page.getByRole('button', { name: 'Создать комнату' })).toBeVisible();
    await expect(tiles(alice.page)).toHaveCount(2);
    await expect(alice.page.getByText('Борис покинул(а) комнату')).toBeVisible();

    // Закрытая вкладка ничем не отличается от выхода: pagehide успевает сказать room:leave,
    // а если нет — сервер заметит обрыв сокета (FR-31, TDD §7.6).
    await carol.page.close();
    await expect(tiles(alice.page)).toHaveCount(1);
    await expect(alice.page.getByText('Вера покинул(а) комнату')).toBeVisible();
  } finally {
    await closeParticipants(alice, bob, carol);
  }
});
