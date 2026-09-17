import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TOAST_TIMEOUT_MS, clear, show } from '../state/toasts.js';
import Toasts from './Toasts.jsx';

/** Тексты уведомлений без кнопки «Скрыть». */
function toastTexts() {
  return screen.getAllByRole('listitem').map((item) => item.firstChild.textContent);
}

afterEach(() => {
  clear();
  vi.useRealTimers();
});

describe('Toasts', () => {
  it('живая область есть всегда, даже пустая: иначе новое уведомление не зачитывается', () => {
    render(<Toasts />);

    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('показывает уведомления в порядке очереди (FR-3, FR-20, FR-33)', () => {
    render(<Toasts />);

    act(() => {
      show('Ссылка скопирована');
      show('Устройство отключено');
    });

    expect(toastTexts()).toEqual(['Ссылка скопирована', 'Устройство отключено']);
    expect(screen.getByRole('status')).toHaveTextContent('Ссылка скопирована');
  });

  it('уведомление скрывается само', () => {
    vi.useFakeTimers();
    render(<Toasts />);

    act(() => {
      show('Ссылка скопирована');
    });
    expect(screen.getByText('Ссылка скопирована')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(TOAST_TIMEOUT_MS);
    });

    expect(screen.queryByText('Ссылка скопирована')).not.toBeInTheDocument();
  });

  it('уведомление можно закрыть вручную', async () => {
    const user = userEvent.setup();
    render(<Toasts />);
    act(() => {
      show('Ссылка скопирована');
      show('Устройство отключено');
    });

    await user.click(screen.getAllByRole('button', { name: 'Скрыть уведомление' })[0]);

    expect(toastTexts()).toEqual(['Устройство отключено']);
  });

  it('отписывается при размонтировании: обновление очереди не роняет приложение', () => {
    const { unmount } = render(<Toasts />);
    unmount();

    expect(() => show('Ссылка скопирована')).not.toThrow();
  });
});
