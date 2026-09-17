import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clear as clearToasts, getSnapshot as toastSnapshot } from '../state/toasts.js';
import { TRACK_STATUS } from '../utils/mediaErrors.js';
import ControlsBar from './ControlsBar.jsx';

function setup(props = {}) {
  const handlers = {
    onToggleMic: vi.fn(),
    onToggleCamera: vi.fn(),
    onLeave: vi.fn(),
  };
  const user = userEvent.setup();
  render(<ControlsBar audio video {...handlers} {...props} />);

  return {
    user,
    ...handlers,
    mic: screen.getByRole('button', { name: 'Микрофон' }),
    camera: screen.getByRole('button', { name: 'Камера' }),
    copy: screen.getByRole('button', { name: 'Скопировать ссылку' }),
    leave: screen.getByRole('button', { name: 'Выйти' }),
  };
}

function toastTexts() {
  return toastSnapshot().map((toast) => toast.text);
}

afterEach(() => {
  clearToasts();
  delete navigator.clipboard;
});

describe('ControlsBar: тумблеры (FR-15, FR-17, US-7)', () => {
  it('включённые устройства: aria-pressed=true', () => {
    const { mic, camera } = setup();

    expect(mic).toHaveAttribute('aria-pressed', 'true');
    expect(camera).toHaveAttribute('aria-pressed', 'true');
  });

  it('выключенные устройства: aria-pressed=false', () => {
    const { mic, camera } = setup({ audio: false, video: false });

    expect(mic).toHaveAttribute('aria-pressed', 'false');
    expect(camera).toHaveAttribute('aria-pressed', 'false');
  });

  it('нажатия вызывают колбэки', async () => {
    const { user, mic, camera, onToggleMic, onToggleCamera } = setup();

    await user.click(mic);
    await user.click(camera);

    expect(onToggleMic).toHaveBeenCalledOnce();
    expect(onToggleCamera).toHaveBeenCalledOnce();
  });

  it('устройства нет: кнопка заблокирована и объясняет причину (FR-14, TDD §8.2)', async () => {
    const { user, mic, camera, onToggleMic } = setup({
      audio: false,
      audioStatus: TRACK_STATUS.NOT_FOUND,
      videoStatus: TRACK_STATUS.OK,
    });

    expect(mic).toBeDisabled();
    expect(mic).toHaveAttribute('title', 'Устройство не найдено');
    expect(camera).toBeEnabled();

    await user.click(mic);
    expect(onToggleMic).not.toHaveBeenCalled();
  });

  it('отказ в доступе кнопку не блокирует: разрешение можно выдать и повторить (FR-33)', () => {
    const { mic, camera } = setup({
      audio: false,
      video: false,
      audioStatus: TRACK_STATUS.DENIED,
      videoStatus: TRACK_STATUS.BUSY,
    });

    expect(mic).toBeEnabled();
    expect(camera).toBeEnabled();
    expect(mic).not.toHaveAttribute('title');
  });
});

describe('ControlsBar: ссылка-приглашение (FR-3, US-3)', () => {
  it('копирует адрес комнаты и показывает уведомление', async () => {
    window.history.replaceState(null, '', '/room/V1StGXR8_Z');
    const { user, copy } = setup();
    // Подмена после userEvent.setup(): он ставит собственную заглушку буфера обмена.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    await user.click(copy);

    expect(writeText).toHaveBeenCalledWith('http://localhost:3000/room/V1StGXR8_Z');
    await waitFor(() => expect(toastTexts()).toEqual(['Ссылка скопирована']));
  });

  it('копирование не удалось: подсказывает скопировать адрес вручную (TDD §8.2)', async () => {
    const { user, copy } = setup();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('нет доступа')) },
      configurable: true,
    });

    await user.click(copy);

    await waitFor(() =>
      expect(toastTexts()).toEqual(['Не удалось скопировать: скопируйте адрес из строки браузера']),
    );
  });
});

describe('ControlsBar: выход (FR-27)', () => {
  it('«Выйти» вызывает колбэк', async () => {
    const { user, leave, onLeave } = setup();

    await user.click(leave);

    expect(onLeave).toHaveBeenCalledOnce();
  });
});
