import { ERROR_CODES, ERROR_MESSAGES, MAX_PARTICIPANTS } from '@vcr/shared';
import { PHASES } from '../state/roomReducer.js';
import './StatusScreen.css';

/**
 * Полноэкранные состояния входа (TDD §4.1.5, §8.1, §8.2). Ключ — фаза `RoomPage`,
 * `actionLabel: null` — экран без действия: исправить окружение можно только вне приложения.
 */
const SCREENS = Object.freeze({
  [PHASES.ROOM_FULL]: {
    title: ERROR_MESSAGES[ERROR_CODES.ROOM_FULL],
    description: `В комнате уже ${MAX_PARTICIPANTS} участника. Попробуйте войти, когда кто-нибудь выйдет.`,
    actionLabel: 'Повторить вход',
  },
  [PHASES.SERVER_UNAVAILABLE]: {
    title: 'Сервер недоступен',
    description: 'Не удалось связаться с сервером. Проверьте подключение и попробуйте ещё раз.',
    actionLabel: 'Повторить',
  },
  [PHASES.UNSUPPORTED]: {
    title: 'Браузер не поддерживает WebRTC',
    description:
      'Ваш браузер не поддерживает WebRTC. Используйте Chrome, Firefox или Edge версии 100+.',
    actionLabel: null,
  },
  [PHASES.INSECURE_CONTEXT]: {
    title: 'Откройте приложение по HTTPS',
    description:
      'Доступ к камере и микрофону браузер выдаёт только на защищённых страницах. Откройте тот же адрес по HTTPS.',
    actionLabel: null,
  },
  [PHASES.CONNECTION_LOST]: {
    title: 'Соединение с сервером потеряно',
    description: 'Переподключение не выполняется автоматически — войдите в комнату заново.',
    actionLabel: 'Войти заново',
  },
});

/** Экран `joinError` объясняет причину отказа сервера: чаще всего это ссылка (TDD §8.1). */
function joinErrorScreen(error) {
  const invalidLink = error === ERROR_CODES.INVALID_ROOM_ID;
  return {
    title: invalidLink ? ERROR_MESSAGES[ERROR_CODES.INVALID_ROOM_ID] : 'Не удалось войти в комнату',
    description: invalidLink
      ? 'Проверьте ссылку-приглашение или создайте новую комнату.'
      : (ERROR_MESSAGES[error] ?? 'Попробуйте создать комнату заново.'),
    actionLabel: 'На главную',
  };
}

/** Тот же адрес по HTTPS: порт и путь сохраняются (TDD §8.2, §12.2). */
function toHttpsUrl(href) {
  const url = new URL(href);
  url.protocol = 'https:';
  return url.href;
}

/**
 * Экран состояния вместо комнаты (FR-8, FR-35, FR-36, US-5, US-13).
 * @param {Object} props
 * @param {string} props.kind  фаза из `PHASES`
 * @param {string|null} [props.error]  код ошибки для фазы `joinError`
 * @param {() => void} [props.onAction]  «Повторить вход», «Войти заново», «На главную»
 */
export default function StatusScreen({ kind, error = null, onAction }) {
  const screen = kind === PHASES.JOIN_ERROR ? joinErrorScreen(error) : SCREENS[kind];
  if (screen === undefined) throw new Error(`StatusScreen: неизвестное состояние ${String(kind)}`);

  return (
    <main className="status-screen">
      <h1 className="status-screen__title">{screen.title}</h1>
      <p className="status-screen__description">{screen.description}</p>
      {kind === PHASES.INSECURE_CONTEXT ? (
        <a className="status-screen__link" href={toHttpsUrl(window.location.href)}>
          Открыть по HTTPS
        </a>
      ) : null}
      {screen.actionLabel === null ? null : (
        <button className="status-screen__action" type="button" onClick={onAction}>
          {screen.actionLabel}
        </button>
      )}
    </main>
  );
}
