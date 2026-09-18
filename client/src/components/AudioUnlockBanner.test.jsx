import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AudioUnlockBanner from './AudioUnlockBanner.jsx';

describe('AudioUnlockBanner (FR-37, TDD §4.1.5)', () => {
  it('скрыт, пока автозапуск не заблокирован', () => {
    render(<AudioUnlockBanner visible={false} onUnlock={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Включить звук' })).not.toBeInTheDocument();
  });

  it('объясняет, что звук заблокирован, и предлагает включить его', () => {
    render(<AudioUnlockBanner visible onUnlock={vi.fn()} />);

    expect(screen.getByText(/заблокировал звук/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Включить звук' })).toBeInTheDocument();
  });

  it('клик по кнопке снимает блокировку', async () => {
    const user = userEvent.setup();
    const onUnlock = vi.fn();
    render(<AudioUnlockBanner visible onUnlock={onUnlock} />);

    await user.click(screen.getByRole('button', { name: 'Включить звук' }));

    expect(onUnlock).toHaveBeenCalledOnce();
  });
});
