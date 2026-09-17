import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LINK_STATUS } from '../state/roomReducer.js';
import VideoTile from './VideoTile.jsx';

function setup(props = {}) {
  const { container } = render(<VideoTile name="Мария" audio video {...props} />);
  return {
    tile: container.querySelector('.video-tile'),
    video: container.querySelector('video'),
    placeholder: container.querySelector('.video-tile__placeholder'),
  };
}

beforeEach(() => {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  delete HTMLMediaElement.prototype.play;
});

describe('VideoTile: видео и имя', () => {
  it('имя выводится оверлеем поверх плитки (FR-12)', () => {
    setup();

    expect(screen.getByText('Мария')).toBeInTheDocument();
  });

  it('видео автозапускается и не переходит в полноэкранный режим на мобильных', () => {
    const { video } = setup();

    expect(video).toHaveAttribute('autoplay');
    expect(video).toHaveAttribute('playsinline');
  });

  it('поток участника попадает в элемент', () => {
    const stream = { id: 'stream-1' };
    const { video } = setup({ stream });

    expect(video.srcObject).toBe(stream);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledOnce();
  });

  it('без потока элемент остаётся пустым: плитка-заглушка видна сразу (TDD §4.1.2)', () => {
    const { video } = setup({ video: false });

    expect(video.srcObject).toBeNull();
    expect(screen.getByText('Мария')).toBeInTheDocument();
  });
});

describe('VideoTile: состояния устройств', () => {
  it('камера выключена: силуэт и имя (FR-18, US-12)', () => {
    const { placeholder } = setup({ video: false });

    expect(placeholder).not.toBeNull();
    expect(screen.getByText('Мария')).toBeInTheDocument();
  });

  it('камера включена: силуэта нет', () => {
    const { placeholder } = setup();

    expect(placeholder).toBeNull();
  });

  it('микрофон выключен: иконка перечёркнутого микрофона (FR-16)', () => {
    setup({ audio: false });

    expect(screen.getByRole('img', { name: 'Микрофон выключен' })).toBeInTheDocument();
  });

  it('микрофон включён: иконки нет', () => {
    setup();

    expect(screen.queryByRole('img', { name: 'Микрофон выключен' })).not.toBeInTheDocument();
  });
});

describe('VideoTile: своя плитка (TDD §4.1.5, Q-1)', () => {
  it('подписана «(Вы)», приглушена и отражена зеркально', () => {
    const { tile, video } = setup({ isSelf: true });

    expect(screen.getByText('Мария (Вы)')).toBeInTheDocument();
    expect(video).toHaveProperty('muted', true);
    expect(tile).toHaveClass('video-tile--self');
  });

  it('чужая плитка звучит и не помечена', () => {
    const { tile, video } = setup();

    expect(video).toHaveProperty('muted', false);
    expect(tile).not.toHaveClass('video-tile--self');
    expect(screen.queryByText('Мария (Вы)')).not.toBeInTheDocument();
  });
});

describe('VideoTile: состояние соединения (FR-34)', () => {
  it('соединение не установилось: бейдж «Нет медиасоединения»', () => {
    setup({ linkStatus: LINK_STATUS.FAILED });

    expect(screen.getByText('Нет медиасоединения')).toBeInTheDocument();
  });

  it.each([LINK_STATUS.CONNECTING, LINK_STATUS.CONNECTED, null])(
    'статус %s бейдж не показывает',
    (linkStatus) => {
      setup({ linkStatus });

      expect(screen.queryByText('Нет медиасоединения')).not.toBeInTheDocument();
    },
  );
});

describe('VideoTile: autoplay', () => {
  it('отказ воспроизведения сообщается наверх (FR-37)', async () => {
    HTMLMediaElement.prototype.play = vi
      .fn()
      .mockRejectedValue(new DOMException('gesture required', 'NotAllowedError'));
    const onAutoplayBlocked = vi.fn();

    setup({ stream: { id: 'stream-1' }, onAutoplayBlocked });

    await vi.waitFor(() => expect(onAutoplayBlocked).toHaveBeenCalledOnce());
  });
});
