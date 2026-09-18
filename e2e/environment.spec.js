// E-7, E-8, E-9 из TDD §11.4: отказ в доступе к устройствам, браузер без WebRTC и недоступный
// сервер. Окружение ломается через addInitScript и перехват маршрутов — до загрузки приложения.
import { expect, test } from '@playwright/test';
import {
  closeParticipants,
  createParticipant,
  createRoom,
  joinRoom,
  submitName,
  tileOf,
} from './support/room.js';

/** Запрет доступа к устройствам: тот же `NotAllowedError`, что даёт браузер после «Запретить». */
function denyMediaAccess(page) {
  return page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true,
      value: () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')),
    });
  });
}

test('E-7: отказ в доступе к устройствам не выбрасывает из комнаты', async ({ browser }) => {
  const alice = await createParticipant(browser, 'Алиса');
  const bob = await createParticipant(browser, 'Борис');

  try {
    await denyMediaAccess(bob.page);
    const roomUrl = await createRoom(alice);
    // Вход доходит до комнаты: без камеры и микрофона участник всё равно видит и слышит
    // остальных (FR-14, FR-33, US-12).
    await joinRoom(bob, roomUrl);

    await expect(
      bob.page.getByText('Нет доступа к камере. Разрешите доступ в настройках браузера'),
    ).toBeVisible();
    await expect(
      bob.page.getByText('Нет доступа к микрофону. Разрешите доступ в настройках браузера'),
    ).toBeVisible();

    // Тумблеры остались в положении «выключено»: включать нечего (TDD §8.2).
    await expect(bob.page.getByRole('button', { name: 'Микрофон' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await expect(bob.page.getByRole('button', { name: 'Камера' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );

    // Силуэт вместо видео — и у себя, и у собеседника (FR-18).
    await expect(tileOf(bob.page, 'Борис (Вы)').locator('.video-tile__placeholder')).toBeVisible();
    await expect(tileOf(alice.page, 'Борис').locator('.video-tile__placeholder')).toBeVisible();
  } finally {
    await closeParticipants(alice, bob);
  }
});

test('E-8: браузер без WebRTC получает экран вместо комнаты', async ({ browser }) => {
  const visitor = await createParticipant(browser, 'Алиса');

  try {
    const { page } = visitor;
    await page.addInitScript(() => {
      delete window.RTCPeerConnection;
    });

    await page.goto('/');
    await submitName(page, visitor.name, 'Создать комнату');

    // Проверка окружения идёт до подключения к серверу (TDD §4.1.2, §8.2).
    await expect(
      page.getByRole('heading', { name: 'Браузер не поддерживает WebRTC' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Выйти' })).toBeHidden();
  } finally {
    await closeParticipants(visitor);
  }
});

test('E-9: недоступный сервер показывает экран с кнопкой «Повторить»', async ({ browser }) => {
  const visitor = await createParticipant(browser, 'Алиса');

  try {
    const { page } = visitor;
    // Обрывать нужно оба транспорта Socket.io: page.route не перехватывает WebSocket, а
    // routeWebSocket не видит polling, с которого начинается подключение (TDD §6.2).
    await page.routeWebSocket(/socket\.io/, (ws) => ws.close());
    await page.route('**/socket.io/**', (route) => route.abort());

    await page.goto('/');
    await submitName(page, visitor.name, 'Создать комнату');

    // Оборванный запрос даёт connect_error сразу, но запас нужен на случай, когда подключение
    // доживает до таймаута в 5 с (TDD §8.2).
    await expect(page.getByRole('heading', { name: 'Сервер недоступен' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('button', { name: 'Повторить' })).toBeVisible();
  } finally {
    await closeParticipants(visitor);
  }
});
