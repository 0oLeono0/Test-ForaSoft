import { useEffect, useReducer, useRef } from 'react';
import { RoomSession } from '../services/RoomSession.js';
import { initialState, roomReducer } from '../state/roomReducer.js';
import * as sessionName from '../state/sessionName.js';
import { clear as clearToasts } from '../state/toasts.js';

/**
 * Жизненный цикл сессии комнаты для `RoomPage` (TDD §4.1.2, §4.1.3).
 *
 * `RoomSession` создаётся и уничтожается в одном эффекте: так двойной прогон эффектов в
 * `StrictMode` даёт чистую пару «создали — закрыли», а не сессию с закрытым сокетом.
 * Наружу она отдаётся ссылкой: сессия — внешняя система, а не состояние React, и рендер
 * вызывают действия reducer, а не смена объекта. До первого эффекта `sessionRef.current`
 * равен `null`: в этот момент на экране форма имени или «Подключаемся…», и звать сессию некому.
 *
 * @param {string} roomId  идентификатор из адреса; его валидность проверяет `RoomSession.start`
 * @returns {{ state: import('../state/roomReducer.js').RoomState, dispatch: Function,
 *             sessionRef: import('react').RefObject<RoomSession|null> }}
 */
export function useRoomSession(roomId) {
  const [state, dispatch] = useReducer(roomReducer, initialState);
  const sessionRef = useRef(null);

  useEffect(() => {
    const created = new RoomSession({ dispatch });
    sessionRef.current = created;

    // Имя уже в памяти — пользователь пришёл с главной в рамках той же загрузки SPA:
    // форма имени пропускается, вход начинается сразу (TDD §4.1.1).
    const name = sessionName.get();
    if (name !== null) created.start({ roomId, name });

    // Закрытие вкладки: сервер заметит обрыв и сам, но best-effort `room:leave` освобождает
    // слот сразу, не дожидаясь ping timeout (TDD §7.6).
    const notifyLeaving = () => created.notifyLeaving();
    window.addEventListener('pagehide', notifyLeaving);

    return () => {
      window.removeEventListener('pagehide', notifyLeaving);
      created.destroy();
      sessionRef.current = null;
      // Уведомления относятся к комнате, из которой мы уходим.
      clearToasts();
    };
  }, [roomId]);

  return { state, dispatch, sessionRef };
}
