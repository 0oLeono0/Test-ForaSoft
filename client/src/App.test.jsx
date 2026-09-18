import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import App from './App.jsx';

function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('App: маршруты', () => {
  it('«/» — стартовый экран', () => {
    renderAt('/');

    expect(screen.getByRole('heading', { name: 'Видеочат-комната' })).toBeInTheDocument();
  });

  it('«/room/:roomId» — экран комнаты', () => {
    // Имени в памяти нет (переход по ссылке-приглашению), поэтому это форма имени (FR-28).
    renderAt('/room/V1StGXR8_Z');

    expect(screen.getByRole('heading', { name: 'Вход в комнату' })).toBeInTheDocument();
  });

  it.each(['/unknown', '/room', '/room/a/b'])('«%s» — редирект на стартовый экран', (path) => {
    renderAt(path);

    expect(screen.getByRole('heading', { name: 'Видеочат-комната' })).toBeInTheDocument();
  });
});
