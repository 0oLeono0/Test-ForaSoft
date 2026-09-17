import { useMediaElement } from '../hooks/useMediaElement.js';
import { LINK_STATUS } from '../state/roomReducer.js';
import { MicOffIcon, PersonIcon } from './icons.jsx';
import './VideoTile.css';

/**
 * Плитка участника (FR-8, FR-11, FR-12, FR-16, FR-18, US-6, US-12).
 *
 * Элемент `<video>` есть всегда, даже без видео: через него идёт звук участника. Своя плитка
 * приглушена (иначе эхо), отражена зеркально и подписана «(Вы)» (TDD §4.1.5, Q-1).
 * @param {Object} props
 * @param {string} props.name
 * @param {MediaStream|null} [props.stream]  поток участника; `null`, пока соединения нет
 * @param {boolean} props.audio  микрофон участника включён
 * @param {boolean} props.video  камера участника включена
 * @param {boolean} [props.isSelf]
 * @param {string|null} [props.linkStatus]  статус P2P-соединения из `LINK_STATUS`
 * @param {() => void} [props.onAutoplayBlocked]  `play()` отклонён до жеста пользователя (FR-37)
 */
export default function VideoTile({
  name,
  stream = null,
  audio,
  video,
  isSelf = false,
  linkStatus = null,
  onAutoplayBlocked,
}) {
  const videoRef = useMediaElement(stream, onAutoplayBlocked);
  const className = `video-tile${isSelf ? ' video-tile--self' : ''}`;

  return (
    <div className={className}>
      <video
        className="video-tile__video"
        ref={videoRef}
        autoPlay
        playsInline
        // Свой звук не воспроизводится: это эхо (TDD §4.1.5).
        muted={isSelf}
      />
      {video ? null : (
        // Камера выключена, отсутствует или недоступна — силуэт и имя (FR-18, US-12).
        <div className="video-tile__placeholder">
          <PersonIcon />
        </div>
      )}
      {linkStatus === LINK_STATUS.FAILED ? (
        <p className="video-tile__badge">Нет медиасоединения</p>
      ) : null}
      <div className="video-tile__overlay">
        <span className="video-tile__name">{isSelf ? `${name} (Вы)` : name}</span>
        {audio ? null : <MicOffIcon title="Микрофон выключен" />}
      </div>
    </div>
  );
}
