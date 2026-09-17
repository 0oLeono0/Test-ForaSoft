import { MAX_PARTICIPANTS } from '@vcr/shared';
import { nanoid } from 'nanoid';
import { useNavigate } from 'react-router-dom';
import NameForm from '../components/NameForm.jsx';
import * as sessionName from '../state/sessionName.js';
import './HomePage.css';

/** Длина идентификатора комнаты: алфавит nanoid укладывается в `ROOM_ID_PATTERN` (TDD §3.4). */
const ROOM_ID_LENGTH = 10;

/**
 * Стартовый экран: имя и «Создать комнату» (FR-1, FR-2, US-1, US-2).
 * Клик по кнопке — тот самый жест пользователя, который снимает запрет autoplay: переход
 * на `/room/:roomId` идёт внутри SPA, без перезагрузки документа (TDD §4.1.1).
 */
export default function HomePage() {
  const navigate = useNavigate();

  /** @param {string} name  нормализованное имя из `NameForm` */
  function handleSubmit(name) {
    sessionName.set(name);
    navigate(`/room/${nanoid(ROOM_ID_LENGTH)}`);
  }

  return (
    <main className="home">
      <h1 className="home__title">Видеочат-комната</h1>
      <p className="home__lead">
        Групповой звонок на {MAX_PARTICIPANTS} участника прямо в браузере: без регистрации и
        установки. Создайте комнату и отправьте ссылку собеседникам.
      </p>
      <NameForm submitLabel="Создать комнату" onSubmit={handleSubmit} />
    </main>
  );
}
