// Дев-хук `window.__vcr` для E2E (TDD §11.4, §13 R-9).
//
// Playwright не умеет заглянуть внутрь RTCPeerConnection, а ждать «видео поехало» по пикселям
// долго и ненадёжно. Поэтому страница сама выставляет наружу статусы пар, состояние локальных
// дорожек и список участников — этого хватает для `waitForPeerConnected`.
//
// Хук существует только при сборке в режиме `test` (`vite build --mode test`): в обычной
// сборке условие ниже сворачивается в константу, и весь блок выкидывается минификатором —
// в `client/dist` не остаётся даже строки `__vcr`.

/** Имя свойства на `window`; в боевую сборку не попадает. */
const HOOK_NAME = '__vcr';

/**
 * @param {Object} params
 * @param {import('../state/roomReducer.js').RoomState} params.state
 * @param {object|null} params.session  `RoomSession`
 * @returns {(() => void)|undefined} снятие хука для эффекта React
 */
export function installTestHook({ state, session }) {
  if (import.meta.env.MODE !== 'test') return undefined;

  // Геттеры, а не снимок: дорожки меняют `readyState` и `enabled` без участия React.
  window[HOOK_NAME] = {
    get participants() {
      return state.participants;
    },
    get links() {
      return state.links;
    },
    get local() {
      return session?.getLocalTracks() ?? { audio: null, video: null };
    },
  };

  return () => {
    delete window[HOOK_NAME];
  };
}
