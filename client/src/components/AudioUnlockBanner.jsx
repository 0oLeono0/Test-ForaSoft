import './AudioUnlockBanner.css';

/**
 * Баннер «Включить звук» (FR-37, TDD §4.1.5, §8.2). Браузер может запретить автозапуск со
 * звуком до первого действия пользователя: тогда `play()` отклоняется с `NotAllowedError`,
 * и звук включает клик по этой кнопке — он и есть недостающий жест.
 * @param {Object} props
 * @param {boolean} props.visible
 * @param {() => void} props.onUnlock
 */
export default function AudioUnlockBanner({ visible, onUnlock }) {
  if (!visible) return null;

  return (
    <div className="audio-unlock" role="status">
      <p className="audio-unlock__text">Браузер заблокировал звук до вашего действия</p>
      <button className="audio-unlock__button" type="button" onClick={onUnlock}>
        Включить звук
      </button>
    </div>
  );
}
