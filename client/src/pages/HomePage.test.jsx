import { isValidRoomId } from '@vcr/shared';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import * as sessionName from '../state/sessionName.js';
import HomePage from './HomePage.jsx';

/** Показывает текущий адрес: так виден переход, который сделал `navigate`. */
function LocationProbe() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

function setup() {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/']}>
      <HomePage />
      <LocationProbe />
    </MemoryRouter>,
  );

  return {
    user,
    field: screen.getByLabelText('Ваше имя'),
    submit: screen.getByRole('button', { name: 'Создать комнату' }),
    path: () => screen.getByTestId('path').textContent,
  };
}

afterEach(() => {
  sessionName.clear();
});

describe('HomePage', () => {
  it('валидное имя: комната с новым id и имя в памяти сессии (FR-2, US-2)', async () => {
    const { user, field, submit, path } = setup();

    await user.type(field, 'Алекс');
    await user.click(submit);

    const roomId = path().replace('/room/', '');
    expect(path()).toBe(`/room/${roomId}`);
    expect(roomId).toHaveLength(10);
    expect(isValidRoomId(roomId)).toBe(true);
    expect(sessionName.get()).toBe('Алекс');
  });

  it('каждый вход создаёт новый идентификатор', async () => {
    const first = setup();
    await first.user.type(first.field, 'Алекс');
    await first.user.click(first.submit);
    const firstRoomId = first.path();

    cleanup();
    const second = setup();
    await second.user.type(second.field, 'Алекс');
    await second.user.click(second.submit);

    expect(second.path()).not.toBe(firstRoomId);
  });

  it.each([
    ['пустое имя', ''],
    ['одни пробелы', '   '],
    ['недопустимые символы', 'Алекс<script>'],
  ])('%s: остаёмся на главной, имя не запоминается (US-1)', async (_, value) => {
    const { user, field, submit, path } = setup();

    if (value !== '') await user.type(field, value);
    await user.click(submit);

    expect(path()).toBe('/');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(sessionName.get()).toBeNull();
  });
});
