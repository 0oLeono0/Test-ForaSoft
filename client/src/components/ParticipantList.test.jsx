import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ParticipantList from './ParticipantList.jsx';

const MARIA = { id: 'p-1', name: 'Мария', audio: true, video: true };
const ALEX = { id: 'p-2', name: 'Алекс', audio: true, video: true };

function names() {
  return screen.getAllByRole('listitem').map((item) => item.textContent);
}

describe('ParticipantList', () => {
  it('показывает имена в порядке входа (FR-26, US-9)', () => {
    render(<ParticipantList participants={[MARIA, ALEX]} selfId={ALEX.id} />);

    expect(names()).toEqual(['Мария', 'Алекс (Вы)']);
    expect(screen.getByRole('heading', { name: 'Участники (2)' })).toBeInTheDocument();
  });

  it('себя помечает «(Вы)», остальных — нет', () => {
    render(<ParticipantList participants={[MARIA, ALEX]} selfId={MARIA.id} />);

    expect(names()).toEqual(['Мария (Вы)', 'Алекс']);
  });

  it('без selfId никто не помечен: список ещё не связан с собой', () => {
    render(<ParticipantList participants={[MARIA]} />);

    expect(names()).toEqual(['Мария']);
  });

  it('одинаковые имена показываются оба (FR-30)', () => {
    const twin = { ...MARIA, id: 'p-9' };
    render(<ParticipantList participants={[MARIA, twin]} selfId={twin.id} />);

    expect(names()).toEqual(['Мария', 'Мария (Вы)']);
  });

  it('выключенный микрофон и камера помечены иконками (FR-15, FR-16)', () => {
    render(
      <ParticipantList
        participants={[
          { ...MARIA, audio: false },
          { ...ALEX, video: false },
        ]}
        selfId={ALEX.id}
      />,
    );

    const [maria, alex] = screen.getAllByRole('listitem');
    expect(within(maria).getByRole('img', { name: 'Микрофон выключен' })).toBeInTheDocument();
    expect(within(maria).queryByRole('img', { name: 'Камера выключена' })).not.toBeInTheDocument();
    expect(within(alex).getByRole('img', { name: 'Камера выключена' })).toBeInTheDocument();
    expect(within(alex).queryByRole('img', { name: 'Микрофон выключен' })).not.toBeInTheDocument();
  });

  it('у участника со включёнными устройствами иконок нет', () => {
    render(<ParticipantList participants={[MARIA]} selfId={MARIA.id} />);

    expect(screen.queryAllByRole('img')).toHaveLength(0);
  });

  it('пустая комната: заголовок без участников', () => {
    render(<ParticipantList participants={[]} />);

    expect(screen.getByRole('heading', { name: 'Участники (0)' })).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });
});
