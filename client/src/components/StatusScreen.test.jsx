import { ERROR_CODES } from '@vcr/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PHASES } from '../state/roomReducer.js';
import StatusScreen from './StatusScreen.jsx';

function setup(props) {
  const onAction = vi.fn();
  const user = userEvent.setup();
  render(<StatusScreen onAction={onAction} {...props} />);

  return { user, onAction };
}

describe('StatusScreen: состояния с действием', () => {
  it.each([
    [PHASES.ROOM_FULL, 'Комната заполнена', 'Повторить вход'],
    [PHASES.SERVER_UNAVAILABLE, 'Сервер недоступен', 'Повторить'],
    [PHASES.CONNECTION_LOST, 'Соединение с сервером потеряно', 'Войти заново'],
  ])('%s: «%s» и кнопка «%s»', async (kind, title, actionLabel) => {
    const { user, onAction } = setup({ kind });

    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: actionLabel }));
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('комната заполнена: объясняет лимит в 4 участника (FR-8, US-5)', () => {
    setup({ kind: PHASES.ROOM_FULL });

    expect(screen.getByText(/4 участника/)).toBeInTheDocument();
  });

  it('обрыв связи: предупреждает, что переподключения не будет (FR-31)', () => {
    setup({ kind: PHASES.CONNECTION_LOST });

    expect(screen.getByText(/не выполняется автоматически/)).toBeInTheDocument();
  });
});

describe('StatusScreen: состояния окружения', () => {
  it('WebRTC не поддерживается: называет подходящие браузеры и не предлагает повтор (FR-36)', () => {
    setup({ kind: PHASES.UNSUPPORTED });

    expect(screen.getByRole('heading', { name: 'Браузер не поддерживает WebRTC' })).toBeVisible();
    expect(screen.getByText(/Chrome, Firefox или Edge версии 100\+/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('незащищённый контекст: ссылка на тот же адрес по HTTPS (PRD §7)', () => {
    window.history.replaceState(null, '', '/room/V1StGXR8_Z');
    setup({ kind: PHASES.INSECURE_CONTEXT });

    expect(screen.getByRole('heading', { name: 'Откройте приложение по HTTPS' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Открыть по HTTPS' })).toHaveAttribute(
      'href',
      'https://localhost:3000/room/V1StGXR8_Z',
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('StatusScreen: joinError', () => {
  it('INVALID_ROOM_ID: про ссылку, кнопка «На главную» (TDD §8.3)', async () => {
    const { user, onAction } = setup({
      kind: PHASES.JOIN_ERROR,
      error: ERROR_CODES.INVALID_ROOM_ID,
    });

    expect(screen.getByRole('heading', { name: 'Некорректная ссылка на комнату' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'На главную' }));
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('другой код ошибки: общий заголовок и текст ошибки сервера', () => {
    setup({ kind: PHASES.JOIN_ERROR, error: ERROR_CODES.INTERNAL_ERROR });

    expect(screen.getByRole('heading', { name: 'Не удалось войти в комнату' })).toBeVisible();
    expect(screen.getByText('Внутренняя ошибка сервера')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'На главную' })).toBeInTheDocument();
  });

  it('без кода ошибки предлагает создать комнату заново', () => {
    setup({ kind: PHASES.JOIN_ERROR });

    expect(screen.getByText('Попробуйте создать комнату заново.')).toBeInTheDocument();
  });
});

describe('StatusScreen: неизвестное состояние', () => {
  it('выбрасывает ошибку вместо пустого экрана', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => render(<StatusScreen kind={PHASES.IN_ROOM} />)).toThrow(
      /неизвестное состояние inRoom/,
    );

    consoleError.mockRestore();
  });
});
