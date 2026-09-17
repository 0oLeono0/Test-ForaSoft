import { fireEvent, render, screen } from '@testing-library/react';
import { useReducer } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { RoomProvider, useRoom } from './RoomContext.jsx';
import { ACTIONS, PHASES, initialState, roomReducer } from './roomReducer.js';

/** Потребитель контекста: показывает фазу и умеет менять её через dispatch. */
function PhaseProbe() {
  const { state, dispatch, session } = useRoom();

  return (
    <div>
      <p data-testid="phase">{state.phase}</p>
      <p data-testid="session">{session === null ? 'нет сессии' : session.name}</p>
      <button
        type="button"
        onClick={() => dispatch({ type: ACTIONS.PHASE, phase: PHASES.JOINING })}
      >
        Войти
      </button>
    </div>
  );
}

/** Провайдер поверх настоящего reducer: так же его использует RoomPage (задача 7.3). */
function RoomHarness({ session }) {
  const [state, dispatch] = useReducer(roomReducer, initialState);

  return (
    <RoomProvider state={state} dispatch={dispatch} session={session}>
      <PhaseProbe />
    </RoomProvider>
  );
}

describe('RoomContext', () => {
  it('отдаёт состояние и сессию вложенным компонентам', () => {
    const session = { name: 'RoomSession' };
    render(<RoomHarness session={session} />);

    expect(screen.getByTestId('phase')).toHaveTextContent(PHASES.NAME_FORM);
    expect(screen.getByTestId('session')).toHaveTextContent('RoomSession');
  });

  it('без сессии отдаёт null, а не падает', () => {
    render(<RoomHarness />);

    expect(screen.getByTestId('session')).toHaveTextContent('нет сессии');
  });

  it('dispatch обновляет состояние потребителей', () => {
    render(<RoomHarness />);

    fireEvent.click(screen.getByRole('button', { name: 'Войти' }));

    expect(screen.getByTestId('phase')).toHaveTextContent(PHASES.JOINING);
  });

  it('вне провайдера useRoom выбрасывает понятную ошибку', () => {
    // React печатает ошибку рендера в консоль — в выводе тестов она не нужна.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => render(<PhaseProbe />)).toThrow('useRoom вызван вне RoomProvider');

    consoleError.mockRestore();
  });
});
