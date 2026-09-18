import { ERROR_CODES } from '@vcr/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACTIONS, PHASES } from '../state/roomReducer.js';
import * as sessionName from '../state/sessionName.js';
import { clear as clearToasts } from '../state/toasts.js';
import { CLIENT_ERROR_CODES } from '../utils/mediaErrors.js';
import RoomPage from './RoomPage.jsx';

const ROOM_ID = 'V1StGXR8_Z';
const SELF = { id: 'b7c1', name: 'Алекс', audio: false, video: false };
const MARIA = { id: '4f2a', name: 'Мария', audio: true, video: true };

/**
 * `RoomSession` подменяется целиком: страница проверяется отдельно от сети (TDD §11.2).
 * Мок запоминает `dispatch`, поэтому тест двигает фазы теми же действиями, что и настоящая сессия.
 */
const sessions = [];

vi.mock('../services/RoomSession.js', () => ({
  RoomSession: class RoomSessionMock {
    constructor({ dispatch }) {
      this.dispatch = dispatch;
      this.limits = { messageMaxLength: 1000 };
      this.start = vi.fn();
      this.leave = vi.fn();
      this.sendMessage = vi.fn(() => Promise.resolve(true));
      this.toggleMic = vi.fn();
      this.toggleCamera = vi.fn();
      // Потоки живут в сервисах: в jsdom `MediaStream` нет, плиткам достаточно `null`.
      this.getStream = vi.fn(() => null);
      this.notifyLeaving = vi.fn();
      this.destroy = vi.fn();
      sessions.push(this);
    }
  },
}));

/** Показывает адрес: так виден переход, который делает `navigate`. */
function LocationProbe() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

function setup() {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[`/room/${ROOM_ID}`]}>
      <Routes>
        <Route path="/room/:roomId" element={<RoomPage />} />
        <Route path="/" element={<h1>Видеочат-комната</h1>} />
      </Routes>
      <LocationProbe />
    </MemoryRouter>,
  );

  return {
    user,
    session: () => sessions.at(-1),
    path: () => screen.getByTestId('path').textContent,
  };
}

/** Действие от имени сессии: React должен успеть перерисоваться до проверок. */
function emit(session, action) {
  act(() => session.dispatch(action));
}

/** Успешный ответ `room:join`. */
function joinOk(session, participants = [MARIA]) {
  emit(session, { type: ACTIONS.JOIN_OK, roomId: ROOM_ID, self: SELF, participants, messages: [] });
}

beforeEach(() => {
  sessions.length = 0;
});

afterEach(() => {
  sessionName.clear();
  clearToasts();
});

describe('RoomPage: начало входа', () => {
  it('без имени в памяти показывается форма имени (FR-28, US-14)', () => {
    // Так выглядит переход по ссылке-приглашению и перезагрузка страницы: имя не хранится.
    const { session } = setup();

    expect(screen.getByLabelText('Ваше имя')).toBeInTheDocument();
    expect(session().start).not.toHaveBeenCalled();
  });

  it('имя уже в памяти: форма пропускается, вход начинается сразу (TDD §4.1.1)', () => {
    sessionName.set('Алекс');

    const { session } = setup();

    expect(screen.queryByLabelText('Ваше имя')).not.toBeInTheDocument();
    expect(screen.getByText('Подключаемся…')).toBeInTheDocument();
    expect(session().start).toHaveBeenCalledWith({ roomId: ROOM_ID, name: 'Алекс' });
  });

  it('валидное имя из формы запоминается и запускает вход (FR-4, US-4)', async () => {
    const { user, session } = setup();

    await user.type(screen.getByLabelText('Ваше имя'), 'Алекс');
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    expect(sessionName.get()).toBe('Алекс');
    expect(session().start).toHaveBeenCalledWith({ roomId: ROOM_ID, name: 'Алекс' });
  });

  it('пока идёт вход, кнопка заблокирована от второго клика (TDD §8.3)', async () => {
    const { user, session } = setup();
    await user.type(screen.getByLabelText('Ваше имя'), 'Алекс');
    const submit = screen.getByRole('button', { name: 'Войти' });
    await user.click(submit);

    emit(session(), { type: ACTIONS.PHASE, phase: PHASES.JOINING });

    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(session().start).toHaveBeenCalledOnce();
  });

  it('INVALID_NAME из ack возвращает на форму с подсказкой (TDD §8.1)', async () => {
    const { user, session } = setup();
    await user.type(screen.getByLabelText('Ваше имя'), 'Алекс');
    await user.click(screen.getByRole('button', { name: 'Войти' }));

    emit(session(), { type: ACTIONS.JOIN_FAILED, error: ERROR_CODES.INVALID_NAME });

    expect(screen.getByLabelText('Ваше имя')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/Имя может содержать/);
  });
});

describe('RoomPage: экран комнаты', () => {
  it('после входа видны участники, плитки и чат (FR-11, FR-26, US-9)', () => {
    sessionName.set('Алекс');
    const { session } = setup();

    joinOk(session());

    const participants = within(screen.getByRole('region', { name: 'Участники' }));
    expect(participants.getByRole('heading', { name: 'Участники (2)' })).toBeInTheDocument();
    expect(participants.getByText('Алекс (Вы)')).toBeInTheDocument();
    expect(participants.getByText('Мария')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Чат' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Скопировать ссылку/ })).toBeInTheDocument();
    // Плитки собраны из тех же участников, своя — первая (TDD §4.1.5).
    const tiles = [...document.querySelectorAll('.video-tile__name')];
    expect(tiles.map((tile) => tile.textContent)).toEqual(['Алекс (Вы)', 'Мария']);
  });

  it('новое сообщение уходит в сессию (FR-21, US-8)', async () => {
    sessionName.set('Алекс');
    const { user, session } = setup();
    joinOk(session());

    await user.type(screen.getByLabelText('Сообщение'), 'Привет');
    await user.click(screen.getByRole('button', { name: 'Отправить' }));

    expect(session().sendMessage).toHaveBeenCalledWith('Привет');
  });

  it('тумблеры микрофона и камеры зовут сессию (FR-15, FR-17, US-7)', async () => {
    sessionName.set('Алекс');
    const { user, session } = setup();
    joinOk(session());

    await user.click(screen.getByRole('button', { name: /Микрофон/ }));
    await user.click(screen.getByRole('button', { name: /Камера/ }));

    expect(session().toggleMic).toHaveBeenCalledOnce();
    expect(session().toggleCamera).toHaveBeenCalledOnce();
  });

  it('плитки берут потоки из сессии, а не из reducer (TDD §4.1.6)', () => {
    sessionName.set('Алекс');
    const { session } = setup();
    joinOk(session());

    expect(session().getStream).toHaveBeenCalledWith(SELF.id);
    expect(session().getStream).toHaveBeenCalledWith(MARIA.id);
  });

  it('«Выйти» прощается с сервером и уводит на главную (FR-27, US-10)', async () => {
    sessionName.set('Алекс');
    const { user, session, path } = setup();
    joinOk(session());

    await user.click(screen.getByRole('button', { name: 'Выйти' }));
    expect(session().leave).toHaveBeenCalledOnce();

    // Переход делает уже сама страница, когда сессия сообщит о завершении (TDD §7.6).
    emit(session(), { type: ACTIONS.LEFT });
    await waitFor(() => expect(path()).toBe('/'));
  });
});

describe('RoomPage: экраны ошибок', () => {
  it('ROOM_FULL: «Повторить вход» запускает вход заново (FR-8, US-5)', async () => {
    sessionName.set('Алекс');
    const { user, session } = setup();
    emit(session(), { type: ACTIONS.JOIN_FAILED, error: ERROR_CODES.ROOM_FULL });

    expect(screen.getByRole('heading', { name: 'Комната заполнена' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Повторить вход' }));

    expect(session().start).toHaveBeenCalledTimes(2);
  });

  it('SERVER_UNAVAILABLE: «Повторить» запускает вход заново (FR-35, US-13)', async () => {
    sessionName.set('Алекс');
    const { user, session } = setup();
    emit(session(), { type: ACTIONS.JOIN_FAILED, error: CLIENT_ERROR_CODES.SERVER_UNAVAILABLE });

    await user.click(screen.getByRole('button', { name: 'Повторить' }));

    expect(session().start).toHaveBeenCalledTimes(2);
  });

  it('обрыв связи: «Войти заново» возвращает к форме имени (FR-31, TDD §4.1.2)', async () => {
    sessionName.set('Алекс');
    const { user, session } = setup();
    joinOk(session());

    emit(session(), { type: ACTIONS.CONNECTION_LOST });
    expect(
      screen.getByRole('heading', { name: 'Соединение с сервером потеряно' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Войти заново' }));

    expect(screen.getByLabelText('Ваше имя')).toBeInTheDocument();
    expect(sessionName.get()).toBeNull();
  });

  it('INVALID_ROOM_ID: «На главную» (TDD §8.3)', async () => {
    sessionName.set('Алекс');
    const { user, session, path } = setup();
    emit(session(), { type: ACTIONS.JOIN_FAILED, error: ERROR_CODES.INVALID_ROOM_ID });

    expect(
      screen.getByRole('heading', { name: 'Некорректная ссылка на комнату' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'На главную' }));

    await waitFor(() => expect(path()).toBe('/'));
  });

  it.each([
    ['незащищённый контекст', CLIENT_ERROR_CODES.INSECURE_CONTEXT, 'Откройте приложение по HTTPS'],
    ['нет WebRTC', CLIENT_ERROR_CODES.WEBRTC_UNSUPPORTED, 'Браузер не поддерживает WebRTC'],
  ])('%s: экран без действия (FR-36)', (_, error, title) => {
    sessionName.set('Алекс');
    const { session } = setup();

    emit(session(), { type: ACTIONS.JOIN_FAILED, error });

    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('RoomPage: жизненный цикл', () => {
  it('закрытие вкладки: best-effort room:leave (FR-28, TDD §7.6)', () => {
    sessionName.set('Алекс');
    const { session } = setup();
    joinOk(session());

    window.dispatchEvent(new Event('pagehide'));

    expect(session().notifyLeaving).toHaveBeenCalledOnce();
  });

  it('размонтирование закрывает сессию и снимает обработчик pagehide', () => {
    sessionName.set('Алекс');
    const { session } = setup();
    const mounted = session();
    joinOk(mounted);

    // Переход на главную размонтирует страницу.
    emit(mounted, { type: ACTIONS.LEFT });

    return waitFor(() => {
      expect(mounted.destroy).toHaveBeenCalled();
      window.dispatchEvent(new Event('pagehide'));
      expect(mounted.notifyLeaving).not.toHaveBeenCalled();
    });
  });
});
