import { show as showToast } from '../state/toasts.js';
import { copyText } from '../utils/clipboard.js';
import { TRACK_STATUS } from '../utils/mediaErrors.js';
import { CameraIcon, CameraOffIcon, MicIcon, MicOffIcon } from './icons.jsx';
import './ControlsBar.css';

/** Подсказка на заблокированной кнопке: устройства нет, включать нечего (TDD §8.2). */
const NOT_FOUND_HINT = 'Устройство не найдено';

/**
 * Панель управления под сеткой (FR-3, FR-15, FR-17, FR-27, US-3, US-7).
 * @param {Object} props
 * @param {boolean} props.audio  микрофон включён
 * @param {boolean} props.video  камера включена
 * @param {string|null} [props.audioStatus]  статус устройства из `TRACK_STATUS`
 * @param {string|null} [props.videoStatus]
 * @param {() => void} props.onToggleMic
 * @param {() => void} props.onToggleCamera
 * @param {() => void} props.onLeave
 */
export default function ControlsBar({
  audio,
  video,
  audioStatus = null,
  videoStatus = null,
  onToggleMic,
  onToggleCamera,
  onLeave,
}) {
  const noMic = audioStatus === TRACK_STATUS.NOT_FOUND;
  const noCamera = videoStatus === TRACK_STATUS.NOT_FOUND;

  async function handleCopyLink() {
    // Ссылка-приглашение — адрес текущей комнаты (FR-3, US-3).
    const copied = await copyText(window.location.href);
    showToast(
      copied ? 'Ссылка скопирована' : 'Не удалось скопировать: скопируйте адрес из строки браузера',
    );
  }

  return (
    <div className="controls-bar">
      <button
        className="controls-bar__button"
        type="button"
        // aria-pressed — состояние тумблера: кнопка остаётся одной и той же (TDD §4.1.5).
        aria-pressed={audio}
        disabled={noMic}
        title={noMic ? NOT_FOUND_HINT : undefined}
        onClick={onToggleMic}
      >
        {audio ? <MicIcon /> : <MicOffIcon />}
        Микрофон
      </button>
      <button
        className="controls-bar__button"
        type="button"
        aria-pressed={video}
        disabled={noCamera}
        title={noCamera ? NOT_FOUND_HINT : undefined}
        onClick={onToggleCamera}
      >
        {video ? <CameraIcon /> : <CameraOffIcon />}
        Камера
      </button>
      <button className="controls-bar__button" type="button" onClick={handleCopyLink}>
        Скопировать ссылку
      </button>
      <button
        className="controls-bar__button controls-bar__button--leave"
        type="button"
        onClick={onLeave}
      >
        Выйти
      </button>
    </div>
  );
}
