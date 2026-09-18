import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import ChatPanel from '../components/ChatPanel.jsx';
import ControlsBar from '../components/ControlsBar.jsx';
import NameForm from '../components/NameForm.jsx';
import ParticipantList from '../components/ParticipantList.jsx';
import RoomLayout from '../components/RoomLayout.jsx';
import StatusScreen from '../components/StatusScreen.jsx';
import Toasts from '../components/Toasts.jsx';
import VideoGrid from '../components/VideoGrid.jsx';
import { useRoomSession } from '../hooks/useRoomSession.js';
import { ACTIONS, PHASES } from '../state/roomReducer.js';
import * as sessionName from '../state/sessionName.js';
import './RoomPage.css';

/** Фазы до входа в комнату: на экране форма имени или ожидание (TDD §4.1.2). */
const PRE_ROOM_PHASES = new Set([
  PHASES.NAME_FORM,
  PHASES.CHECKING_ENV,
  PHASES.CONNECTING,
  PHASES.JOINING,
]);

/**
 * Экран входа: форма имени или «Подключаемся…», если имя уже известно (TDD §4.1.1, §4.1.2).
 * Кнопка блокируется на время подключения — это защита от двойного клика (TDD §8.3).
 * @param {Object} props
 * @param {string} props.phase
 * @param {string|null} props.error  например `INVALID_NAME` из ack: подсказка под полем (§8.1)
 * @param {boolean} props.waiting  имя уже есть, форма не нужна
 * @param {(name: string) => void} props.onSubmit
 */
function JoinScreen({ phase, error, waiting, onSubmit }) {
  return (
    <main className="join-screen">
      <h1 className="join-screen__title">Вход в комнату</h1>
      {waiting ? (
        <p className="join-screen__status">Подключаемся…</p>
      ) : (
        <NameForm
          submitLabel="Войти"
          onSubmit={onSubmit}
          busy={phase !== PHASES.NAME_FORM}
          error={error}
        />
      )}
    </main>
  );
}

/**
 * Комната: конечный автомат входа, сетка, панель управления, участники и чат
 * (FR-4, FR-5, FR-8, FR-11, FR-26…FR-29, FR-35, TDD §4.1.1, §4.1.2).
 */
export default function RoomPage() {
  const { roomId } = useParams();
  const navigate = useNavigate();
  const { state, dispatch, session } = useRoomSession(roomId);
  // Пользователь пришёл с главной: имя уже в памяти, форма не показывается (TDD §4.1.1).
  const [waitingWithoutForm, setWaitingWithoutForm] = useState(() => sessionName.get() !== null);

  useEffect(() => {
    // «Выйти» доводит до главной уже после того, как сессия попрощалась с сервером (TDD §7.6).
    if (state.phase === PHASES.LEFT) navigate('/');
  }, [state.phase, navigate]);

  /** @param {string} name  нормализованное имя из `NameForm` */
  function handleNameSubmit(name) {
    sessionName.set(name);
    session?.start({ roomId, name });
  }

  /** «Повторить вход» после «Комната заполнена» и «Повторить» после «Сервер недоступен». */
  function handleRetry() {
    const name = sessionName.get();
    if (name === null) {
      handleRejoin();
      return;
    }
    session?.start({ roomId, name });
  }

  /** «Войти заново» после обрыва: новый вход начинается с имени (FR-31, TDD §4.1.2). */
  function handleRejoin() {
    sessionName.clear();
    setWaitingWithoutForm(false);
    dispatch({ type: ACTIONS.PHASE, phase: PHASES.NAME_FORM });
  }

  /** Действие экрана состояния: у `unsupported` и `insecureContext` кнопки нет (TDD §4.1.5). */
  function statusAction() {
    if (state.phase === PHASES.CONNECTION_LOST) return handleRejoin;
    if (state.phase === PHASES.JOIN_ERROR) return () => navigate('/');
    return handleRetry;
  }

  // Потоки живут в сервисах, а не в reducer: `MediaStream` не сериализуется (TDD §4.1.6).
  const tiles = state.participants.map((participant) => ({
    id: participant.id,
    name: participant.name,
    stream: session?.getStream(participant.id) ?? null,
    audio: participant.audio,
    video: participant.video,
    isSelf: participant.id === state.selfId,
    linkStatus: state.links[participant.id] ?? null,
  }));

  return (
    <>
      {renderPhase()}
      <Toasts />
    </>
  );

  function renderPhase() {
    if (PRE_ROOM_PHASES.has(state.phase)) {
      return (
        <JoinScreen
          phase={state.phase}
          error={state.error}
          waiting={waitingWithoutForm}
          onSubmit={handleNameSubmit}
        />
      );
    }

    // Переход на главную уже запланирован эффектом: показывать комнату больше нечего.
    if (state.phase === PHASES.LEFT) return null;

    if (state.phase !== PHASES.IN_ROOM) {
      return <StatusScreen kind={state.phase} error={state.error} onAction={statusAction()} />;
    }

    return (
      <RoomLayout
        controls={
          <ControlsBar
            audio={state.local.audio}
            video={state.local.video}
            audioStatus={state.local.audioStatus}
            videoStatus={state.local.videoStatus}
            onToggleMic={() => session?.toggleMic()}
            onToggleCamera={() => session?.toggleCamera()}
            onLeave={() => session?.leave()}
          />
        }
        sidebar={
          <>
            <ParticipantList participants={state.participants} selfId={state.selfId} />
            {/* Предел длины берётся из ack `room:join` (TDD §6.3): к этому рендеру он уже
                получен — фаза `inRoom` наступает только после `JOIN_OK`. */}
            <ChatPanel
              messages={state.messages}
              onSend={(text) => session.sendMessage(text)}
              maxLength={session?.limits.messageMaxLength}
            />
          </>
        }
      >
        <VideoGrid tiles={tiles} />
      </RoomLayout>
    );
  }
}
