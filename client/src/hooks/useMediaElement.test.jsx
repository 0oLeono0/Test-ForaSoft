import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useMediaElement } from './useMediaElement.js';

/** jsdom не реализует воспроизведение: play подменяется, srcObject — обычное свойство. */
let play;

function Player({ stream, onAutoplayBlocked }) {
  const ref = useMediaElement(stream, onAutoplayBlocked);
  return <video ref={ref} data-testid="video" />;
}

function renderPlayer(props = {}) {
  const view = render(<Player {...props} />);
  return { ...view, video: view.getByTestId('video') };
}

beforeEach(() => {
  play = vi.fn().mockResolvedValue(undefined);
  HTMLMediaElement.prototype.play = play;
});

afterEach(() => {
  delete HTMLMediaElement.prototype.play;
});

describe('useMediaElement', () => {
  it('привязывает поток и запускает воспроизведение', () => {
    const stream = { id: 'stream-1' };
    const { video } = renderPlayer({ stream });

    expect(video.srcObject).toBe(stream);
    expect(play).toHaveBeenCalledOnce();
  });

  it('без потока ничего не запускает', () => {
    const { video } = renderPlayer();

    expect(video.srcObject).toBeNull();
    expect(play).not.toHaveBeenCalled();
  });

  it('новый поток заменяет прежний', () => {
    const first = { id: 'stream-1' };
    const second = { id: 'stream-2' };
    const { video, rerender } = renderPlayer({ stream: first });

    rerender(<Player stream={second} />);

    expect(video.srcObject).toBe(second);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it('при размонтировании отвязывает поток', () => {
    const stream = { id: 'stream-1' };
    const { video, unmount } = renderPlayer({ stream });

    unmount();

    expect(video.srcObject).toBeNull();
  });

  it('autoplay заблокирован: сообщает наверх (FR-37, TDD §8.2)', async () => {
    play.mockRejectedValue(new DOMException('gesture required', 'NotAllowedError'));
    const onAutoplayBlocked = vi.fn();

    renderPlayer({ stream: { id: 'stream-1' }, onAutoplayBlocked });
    await vi.waitFor(() => expect(onAutoplayBlocked).toHaveBeenCalledOnce());
  });

  it('прерванный play при смене потока за блокировку autoplay не считается', async () => {
    play.mockRejectedValue(new DOMException('interrupted', 'AbortError'));
    const onAutoplayBlocked = vi.fn();

    renderPlayer({ stream: { id: 'stream-1' }, onAutoplayBlocked });
    await Promise.resolve();

    expect(onAutoplayBlocked).not.toHaveBeenCalled();
  });

  it('отказ после размонтирования наверх не уходит', async () => {
    let rejectPlay;
    play.mockReturnValue(
      new Promise((_, reject) => {
        rejectPlay = reject;
      }),
    );
    const onAutoplayBlocked = vi.fn();
    const { unmount } = renderPlayer({ stream: { id: 'stream-1' }, onAutoplayBlocked });

    unmount();
    rejectPlay(new DOMException('gesture required', 'NotAllowedError'));
    await Promise.resolve();

    expect(onAutoplayBlocked).not.toHaveBeenCalled();
  });

  it('play без промиса (старые браузеры) не ломает привязку', () => {
    play.mockReturnValue(undefined);
    const stream = { id: 'stream-1' };

    expect(() => renderPlayer({ stream })).not.toThrow();
  });

  it('смена колбэка поток не перепривязывает', () => {
    const stream = { id: 'stream-1' };
    const { rerender } = renderPlayer({ stream, onAutoplayBlocked: vi.fn() });

    rerender(<Player stream={stream} onAutoplayBlocked={vi.fn()} />);

    expect(play).toHaveBeenCalledOnce();
  });
});
