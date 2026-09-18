import { useEffect, useReducer, useState, useSyncExternalStore } from 'react';
import { RoomSession } from '../services/RoomSession.js';
import { initialState, roomReducer } from '../state/roomReducer.js';
import * as sessionName from '../state/sessionName.js';
import { clear as clearToasts } from '../state/toasts.js';

/**
 * Маленькое внешнее хранилище на одну ссылку: сессия рождается в эффекте, а плиткам она нужна
 * уже в рендере — они спрашивают у неё потоки (TDD §4.1.6). Тот же приём, что у очереди
 * уведомлений: `useSyncExternalStore` вместо чтения `ref.current` во время отрисовки.
 */
function createSessionHolder() {
  /** @type {RoomSession|null} */
  let session = null;
  /** @type {Set<() => void>} */
  const listeners = new Set();

  return {
    getSnapshot: () => session,
    publish(next) {
      session = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Жизненный цикл сессии комнаты для `RoomPage` (TDD §4.1.2, §4.1.3).
 *
 * `RoomSession` создаётся и уничтожается в одном эффекте: так двойной прогон эффектов в
 * `StrictMode` даёт чистую пару «создали — закрыли», а не сессию с закрытым сокетом. До этого
 * эффекта сессия равна `null`: в этот момент на экране форма имени или «Подключаемся…», и
 * звать её некому. Рендер вызывают действия reducer, а не смена этого объекта: сессия —
 * внешняя система, а не состояние React.
 *
 * @param {string} roomId  идентификатор из адреса; его валидность проверяет `RoomSession.start`
 * @returns {{ state: import('../state/roomReducer.js').RoomState, dispatch: Function,
 *             session: RoomSession|null }}
 */
export function useRoomSession(roomId) {
  const [state, dispatch] = useReducer(roomReducer, initialState);
  const [holder] = useState(createSessionHolder);
  const session = useSyncExternalStore(holder.subscribe, holder.getSnapshot);

  useEffect(() => {
    const created = new RoomSession({ dispatch });
    holder.publish(created);

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
      holder.publish(null);
      // Уведомления относятся к комнате, из которой мы уходим.
      clearToasts();
    };
  }, [roomId, holder]);

  return { state, dispatch, session };
}
