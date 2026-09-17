import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import RoomLayout from './RoomLayout.jsx';

describe('RoomLayout', () => {
  it('показывает сетку, панель управления и правую панель', () => {
    render(
      <RoomLayout controls={<button type="button">Выйти</button>} sidebar={<p>Чат</p>}>
        <p>Сетка</p>
      </RoomLayout>,
    );

    expect(screen.getByRole('main')).toHaveTextContent('Сетка');
    expect(screen.getByRole('button', { name: 'Выйти' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Участники и чат' })).toHaveTextContent('Чат');
  });

  it('без панели управления её контейнер не рендерится', () => {
    const { container } = render(<RoomLayout sidebar={null}>Сетка</RoomLayout>);

    expect(container.querySelector('.room-layout__controls')).toBeNull();
  });
});
