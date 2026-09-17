// Доступ к состоянию комнаты и к сессии из любого компонента экрана (TDD §4.1.6).
import { createContext, useContext, useMemo } from 'react';

/** @typedef {import('./roomReducer.js').RoomState} RoomState */

/**
 * `null` вне провайдера — `useRoom` отличает «нет провайдера» от «состояние ещё не готово».
 * @type {import('react').Context<{ state: RoomState, dispatch: Function, session: object|null }|null>}
 */
const RoomContext = createContext(null);

/**
 * @param {Object} props
 * @param {RoomState} props.state
 * @param {Function} props.dispatch
 * @param {object|null} [props.session]  `RoomSession`; в компонентных тестах — мок
 * @param {import('react').ReactNode} props.children
 */
export function RoomProvider({ state, dispatch, session = null, children }) {
  // MediaStream в состоянии не лежит (TDD §4.1.6): потоки компоненты берут у сессии.
  const value = useMemo(() => ({ state, dispatch, session }), [state, dispatch, session]);
  return <RoomContext.Provider value={value}>{children}</RoomContext.Provider>;
}

/**
 * @returns {{ state: RoomState, dispatch: Function, session: object|null }}
 * @throws {Error} если компонент отрисован вне `RoomProvider`
 */
export function useRoom() {
  const value = useContext(RoomContext);
  if (value === null) throw new Error('useRoom вызван вне RoomProvider');
  return value;
}
