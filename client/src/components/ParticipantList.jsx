import { CameraOffIcon, MicOffIcon } from './icons.jsx';
import './ParticipantList.css';

/** @typedef {import('../state/roomReducer.js').ParticipantView} ParticipantView */

/**
 * Список участников комнаты (FR-26, US-9). Порядок — порядок входа, ключи — идентификаторы:
 * одинаковые имена допустимы и показываются оба (FR-30).
 * @param {Object} props
 * @param {ParticipantView[]} props.participants
 * @param {string|null} [props.selfId]
 */
export default function ParticipantList({ participants, selfId = null }) {
  return (
    <section className="participants" aria-label="Участники">
      <h2 className="participants__title">Участники ({participants.length})</h2>
      <ul className="participants__list">
        {participants.map((participant) => (
          <li className="participant" key={participant.id}>
            <span className="participant__name">
              {participant.id === selfId ? `${participant.name} (Вы)` : participant.name}
            </span>
            <span className="participant__icons">
              {participant.audio ? null : <MicOffIcon title="Микрофон выключен" />}
              {participant.video ? null : <CameraOffIcon title="Камера выключена" />}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
