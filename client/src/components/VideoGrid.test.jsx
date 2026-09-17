import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VideoGrid from './VideoGrid.jsx';

const SELF = { id: 'self-1', name: 'Алекс', audio: true, video: true, isSelf: true };
const MARIA = { id: 'p-2', name: 'Мария', audio: true, video: true };
const PETR = { id: 'p-3', name: 'Пётр', audio: true, video: true };
const OLGA = { id: 'p-4', name: 'Ольга', audio: true, video: true };

function setup(tiles, props = {}) {
  const { container } = render(<VideoGrid tiles={tiles} {...props} />);
  return {
    grid: container.querySelector('.video-grid'),
    names: [...container.querySelectorAll('.video-tile__name')].map((node) => node.textContent),
  };
}

beforeEach(() => {
  HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  delete HTMLMediaElement.prototype.play;
});

describe('VideoGrid: раскладка (FR-11, US-6)', () => {
  it.each([
    [1, '1', '1', [SELF]],
    [2, '2', '1', [SELF, MARIA]],
    [3, '2', '2', [SELF, MARIA, PETR]],
    [4, '2', '2', [SELF, MARIA, PETR, OLGA]],
  ])('%i плиток: %s колонок × %s рядов', (count, columns, rows, tiles) => {
    const { grid } = setup(tiles);

    expect(grid).toHaveAttribute('data-columns', columns);
    expect(grid).toHaveAttribute('data-rows', rows);
    expect(grid.querySelectorAll('.video-tile')).toHaveLength(count);
  });
});

describe('VideoGrid: порядок плиток', () => {
  it('своя плитка всегда первая (TDD §4.1.5, Q-1)', () => {
    const { names } = setup([MARIA, PETR, SELF]);

    expect(names).toEqual(['Алекс (Вы)', 'Мария', 'Пётр']);
  });

  it('порядок остальных — порядок входа', () => {
    const { names } = setup([SELF, MARIA, PETR, OLGA]);

    expect(names).toEqual(['Алекс (Вы)', 'Мария', 'Пётр', 'Ольга']);
  });

  it('без своей плитки порядок не меняется', () => {
    const { names } = setup([MARIA, PETR]);

    expect(names).toEqual(['Мария', 'Пётр']);
  });
});

describe('VideoGrid: состояния плиток', () => {
  it('передаёт участникам их потоки и состояния устройств', () => {
    const stream = { id: 'stream-2' };
    setup([SELF, { ...MARIA, stream, audio: false, video: false }]);

    expect(screen.getByRole('img', { name: 'Микрофон выключен' })).toBeInTheDocument();
    expect(document.querySelectorAll('.video-tile__placeholder')).toHaveLength(1);
    expect([...document.querySelectorAll('video')].at(-1).srcObject).toBe(stream);
  });

  it('сообщает о заблокированном autoplay из любой плитки (FR-37)', async () => {
    HTMLMediaElement.prototype.play = vi
      .fn()
      .mockRejectedValue(new DOMException('gesture required', 'NotAllowedError'));
    const onAutoplayBlocked = vi.fn();

    setup([SELF, { ...MARIA, stream: { id: 'stream-2' } }], { onAutoplayBlocked });

    await vi.waitFor(() => expect(onAutoplayBlocked).toHaveBeenCalledOnce());
  });
});
