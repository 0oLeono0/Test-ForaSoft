// Оркестратор одной сессии комнаты (TDD §4.1.3): ведёт конечный автомат входа, связывает
// сигналинг, локальные устройства и mesh, переводит события сервера в действия reducer.
import {
  ERROR_CODES,
  ERROR_MESSAGES,
  MESSAGE_MAX_LENGTH,
  SERVER_EVENTS,
  isValidRoomId,
} from '@vcr/shared';
import { ACTIONS, PHASES } from '../state/roomReducer.js';
import { show as showToast } from '../state/toasts.js';
import {
  CLIENT_ERROR_CODES,
  DEVICE_LOST_MESSAGE,
  deviceErrorMessage,
} from '../utils/mediaErrors.js';
import { MediaManager, TRACK_KINDS } from './MediaManager.js';
import { PeerMesh } from './PeerMesh.js';
import { SIGNALING_EVENTS, createSignalingClient } from './SignalingClient.js';
import { checkSupport as defaultCheckSupport } from './environment.js';

/**
 * Ошибки `chat:send`, о которых пользователю сообщать нечего (TDD §8.1): пустое сообщение
 * кнопка «Отправить» и так не пропускает, а `NOT_IN_ROOM` приходит уже после выхода.
 */
const SILENT_CHAT_ERRORS = new Set([ERROR_CODES.MESSAGE_EMPTY, ERROR_CODES.NOT_IN_ROOM]);

/** Запасной текст: код есть, а текста для UI в §8.1 нет (например, таймаут ack). */
const CHAT_FALLBACK_MESSAGE = 'Сообщение не отправлено. Попробуйте ещё раз';

export class RoomSession {
  #dispatch;
  #signaling;
  #checkSupport;
  #createMediaManager;
  #createMesh;
  /** @type {(() => void)[]} отписки от событий сервера; снимаются в `destroy` и при обрыве */
  #unsubscribes = [];
  /** Вход уже идёт или завершился успехом: защита от двойного клика (TDD §8.3). */
  #started = false;
  #inRoom = false;
  #destroyed = false;
  #limits = { messageMaxLength: MESSAGE_MAX_LENGTH };
  /** @type {RTCIceServer[]} из ack `room:join`; их получает `PeerLink` (TDD §4.1.4). */
  #iceServers = [];
  #selfId = null;
  /** @type {MediaManager|null} живёт от входа в комнату до выхода или обрыва */
  #media = null;
  /** @type {PeerMesh|null} */
  #mesh = null;
  /** Тумблеры, у которых ещё не закончился `getUserMedia`: второй щелчок пропускаем. */
  #pendingToggles = new Set();
  /** Последняя дорожка каждого вида, включая остановленную, — только для `getLocalTracks`. */
  #lastLocalTracks = { audio: null, video: null };

  /**
   * @param {Object} deps
   * @param {(action: object) => void} deps.dispatch  `dispatch` из `useReducer(roomReducer)`
   * @param {object} [deps.signaling]  `SignalingClient`; в тестах — мок
   * @param {() => { ok: boolean, reason?: string }} [deps.checkSupport]
   * @param {() => MediaManager} [deps.createMediaManager]
   * @param {(deps: object) => PeerMesh} [deps.createMesh]
   */
  constructor({
    dispatch,
    signaling,
    checkSupport = defaultCheckSupport,
    createMediaManager = () => new MediaManager(),
    createMesh = (deps) => new PeerMesh(deps),
  }) {
    this.#dispatch = dispatch;
    this.#signaling = signaling ?? createSignalingClient();
    this.#checkSupport = checkSupport;
    this.#createMediaManager = createMediaManager;
    this.#createMesh = createMesh;
  }

  /** Пределы из ack `room:join`: длина сообщения может отличаться от константы клиента (§6.3). */
  get limits() {
    return this.#limits;
  }

  /** @returns {RTCIceServer[]} */
  get iceServers() {
    return this.#iceServers;
  }

  /** @returns {string|null} */
  get selfId() {
    return this.#selfId;
  }

  /**
   * Вход в комнату: проверка окружения → подключение → `room:join` (TDD §4.1.2).
   * Повторный вызов во время входа игнорируется; после экрана ошибки («Повторить вход»,
   * «Войти заново») вызывать можно снова.
   * @param {{ roomId: string, name: string }} params
   * @returns {Promise<void>}
   */
  async start({ roomId, name }) {
    if (this.#started || this.#destroyed) return;
    this.#started = true;

    this.#dispatch({ type: ACTIONS.PHASE, phase: PHASES.CHECKING_ENV });
    const support = this.#checkSupport();
    if (!support.ok) return this.#fail(support.reason);
    // Ссылку с мусором вместо roomId незачем нести на сервер — ответ известен заранее (TDD §8.3).
    if (!isValidRoomId(roomId)) return this.#fail(ERROR_CODES.INVALID_ROOM_ID);

    this.#dispatch({ type: ACTIONS.PHASE, phase: PHASES.CONNECTING });
    try {
      await this.#signaling.connect();
    } catch (error) {
      return this.#fail(error?.code ?? CLIENT_ERROR_CODES.SERVER_UNAVAILABLE);
    }
    if (this.#destroyed) return;

    // Подписки — до `join`: событие о следующем участнике может прийти сразу за ack.
    this.#subscribe();

    this.#dispatch({ type: ACTIONS.PHASE, phase: PHASES.JOINING });
    let ack;
    try {
      ack = await this.#signaling.join(roomId, name);
    } catch (error) {
      // `ALREADY_IN_ROOM` — эхо второго `room:join`: вход уже состоялся, экран менять не нужно.
      if (error?.code === ERROR_CODES.ALREADY_IN_ROOM) return;
      return this.#fail(error?.code ?? ERROR_CODES.INTERNAL_ERROR);
    }
    if (this.#destroyed) return;

    this.#limits = ack.limits ?? this.#limits;
    this.#iceServers = ack.iceServers ?? [];
    this.#selfId = ack.self.id;
    this.#inRoom = true;
    this.#dispatch({
      type: ACTIONS.JOIN_OK,
      roomId,
      self: ack.self,
      participants: ack.participants,
      messages: ack.messages,
    });
    this.#startMedia(ack.participants.map(({ id }) => id));
  }

  /** Тумблер микрофона (FR-15, US-7). @returns {Promise<void>} */
  toggleMic() {
    return this.#toggleDevice('audio');
  }

  /** Тумблер камеры (FR-17, US-7). @returns {Promise<void>} */
  toggleCamera() {
    return this.#toggleDevice('video');
  }

  /**
   * Поток для плитки участника (TDD §4.1.6): `MediaStream` в reducer не кладётся.
   * @param {string} peerId
   * @returns {MediaStream|null}
   */
  getStream(peerId) {
    if (peerId === this.#selfId) return this.#media?.localStream ?? null;
    return this.#mesh?.getStream(peerId) ?? null;
  }

  /**
   * Состояние локальных дорожек для дев-хука `window.__vcr` (TDD §11.4). Отдаётся последняя
   * дорожка каждого вида, даже остановленная: по её `readyState === 'ended'` E2E убеждается,
   * что выключение камеры действительно освободило устройство (FR-19, сценарий E-4).
   * @returns {Record<string, { readyState: string, enabled: boolean }|null>}
   */
  getLocalTracks() {
    const snapshot = {};
    for (const kind of TRACK_KINDS) {
      const track = this.#lastLocalTracks[kind];
      snapshot[kind] =
        track === null ? null : { readyState: track.readyState, enabled: track.enabled };
    }
    return snapshot;
  }

  /**
   * Отправка сообщения. Своё сообщение приходит броадкастом и отрисовывается оттуда, поэтому
   * ack нужен только для подтверждения и ошибок (TDD §6.4).
   * @param {string} text
   * @returns {Promise<boolean>}  `false` — текст остаётся в поле ввода (TDD §8.1)
   */
  async sendMessage(text) {
    try {
      await this.#signaling.sendChat(text);
      return true;
    } catch (error) {
      const code = error?.code;
      if (!SILENT_CHAT_ERRORS.has(code)) {
        showToast(ERROR_MESSAGES[code] ?? CHAT_FALLBACK_MESSAGE);
      }
      return false;
    }
  }

  /**
   * Выход по кнопке (TDD §7.6): дожидаемся ack, чтобы сервер успел разослать `participant:left`,
   * затем закрываем сокет. Ошибка ack ничего не меняет — `disconnect` освободит слот в любом случае.
   * @returns {Promise<void>}
   */
  async leave() {
    if (this.#destroyed) return;
    this.#inRoom = false;
    try {
      await this.#signaling.leave();
    } catch {
      // Сокет всё равно закрывается: сервер освободит слот в обработчике `disconnect`.
    }
    if (this.#destroyed) return;
    this.#cleanup();
    this.#signaling.disconnect();
    this.#started = false;
    this.#dispatch({ type: ACTIONS.LEFT });
  }

  /**
   * Закрытие или перезагрузка вкладки (TDD §7.6): `room:leave` уходит без ожидания ack —
   * страница вот-вот исчезнет. Если событие не успеет дойти, слот освободит обработчик
   * `disconnect` на сервере, просто чуть позже.
   */
  notifyLeaving() {
    if (!this.#inRoom || this.#destroyed) return;
    this.#inRoom = false;
    this.#signaling.leave().catch(() => {
      // Ответ нас уже не застанет.
    });
  }

  /** Размонтирование `RoomPage`: снять подписки и закрыть сокет, состояние уже не нужно. */
  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#cleanup();
    this.#signaling.disconnect();
  }

  #subscribe() {
    if (this.#unsubscribes.length > 0) return;
    const on = (event, handler) => this.#unsubscribes.push(this.#signaling.on(event, handler));

    on(SERVER_EVENTS.PARTICIPANT_JOINED, ({ participant }) => {
      this.#dispatch({ type: ACTIONS.PARTICIPANT_JOINED, participant });
    });
    on(SERVER_EVENTS.PARTICIPANT_LEFT, ({ participantId }) => {
      // Соединение закрывается сразу: поздние сигналы от ушедшего уже не нужны (TDD §7.6).
      this.#mesh?.removePeer(participantId);
      this.#dispatch({ type: ACTIONS.PARTICIPANT_LEFT, participantId });
    });
    on(SERVER_EVENTS.PARTICIPANT_MEDIA, ({ participantId, audio, video }) => {
      this.#dispatch({ type: ACTIONS.PARTICIPANT_MEDIA, participantId, audio, video });
    });
    on(SERVER_EVENTS.CHAT_MESSAGE, ({ message }) => {
      this.#dispatch({ type: ACTIONS.CHAT_MESSAGE, message });
    });
    on(SERVER_EVENTS.SIGNAL, ({ from, data }) => {
      void this.#mesh?.handleSignal(from, data);
    });
    on(SERVER_EVENTS.SIGNAL_ERROR, ({ to, code }) => {
      // Получатель успел выйти (TDD §8.1): пара больше не нужна. Остальные коды сигналинга
      // закрывать соединение не повод — его и так пометит failed таймаут в `PeerLink`.
      if (code === ERROR_CODES.PEER_NOT_FOUND && typeof to === 'string') {
        this.#mesh?.removePeer(to);
      }
    });
    on(SIGNALING_EVENTS.DISCONNECTED, (event) => this.#handleDisconnected(event));
  }

  /**
   * После `JOIN_OK` mesh и захват устройств идут параллельно (TDD §7.2): offer уходит
   * сразу с `null`-дорожками, а диалог разрешений догоняет его через `replaceTrack`.
   * @param {string[]} peerIds  участники из ack — те, кто вошёл раньше нас (TDD §3.2)
   */
  #startMedia(peerIds) {
    this.#media = this.#createMediaManager();
    this.#mesh = this.#createMesh({
      sendSignal: (peerId, data) => this.#signaling.sendSignal(peerId, data),
      iceServers: this.#iceServers,
      getLocalTrack: (kind) => this.#media?.getTrack(kind) ?? null,
    });

    this.#mesh.onStatus((peerId, status) => {
      this.#dispatch({ type: ACTIONS.LINK_STATUS, peerId, status });
    });
    // Новая или пропавшая дорожка расходится по парам без повторного согласования (TDD §7.4).
    this.#media.onTrackChange((kind, track) => {
      if (track !== null) this.#lastLocalTracks[kind] = track;
      this.#mesh?.broadcastTrack(kind, track);
    });
    this.#media.onDeviceLost(() => {
      showToast(DEVICE_LOST_MESSAGE);
      this.#publishLocalMedia();
    });

    this.#mesh.connectTo(peerIds);
    void this.#acquireMedia();
  }

  /** Первичный захват: результат — в reducer, дорожки — пирам, состояние — на сервер. */
  async #acquireMedia() {
    const media = this.#media;
    const result = await media.acquire();
    // Пока шёл диалог разрешений, из комнаты могли выйти: дорожки уже остановил `dispose`.
    if (this.#media !== media || !this.#inRoom) return;

    for (const kind of TRACK_KINDS) {
      this.#lastLocalTracks[kind] = media.getTrack(kind);
      this.#mesh.broadcastTrack(kind, this.#lastLocalTracks[kind]);
    }
    this.#publishLocalMedia();
    // Отказ и занятое устройство из комнаты не выбрасывают — только объясняют (FR-33, §8.2).
    for (const kind of TRACK_KINDS) this.#notifyDeviceError(kind, result[kind].status);
  }

  /**
   * Переключение устройства (TDD §7.4). Неудачное включение состояние не меняет: тумблер
   * остаётся выключенным, а причина уходит в toast.
   * @param {import('./MediaManager.js').TrackKind} kind
   */
  async #toggleDevice(kind) {
    const media = this.#media;
    if (media === null || this.#pendingToggles.has(kind)) return;
    this.#pendingToggles.add(kind);
    try {
      const enabled = !media.getMediaState()[kind];
      const status =
        kind === 'audio'
          ? await media.setAudioEnabled(enabled)
          : await media.setVideoEnabled(enabled);
      if (this.#media !== media || !this.#inRoom) return;
      if (enabled) this.#notifyDeviceError(kind, status);
      this.#publishLocalMedia();
    } finally {
      this.#pendingToggles.delete(kind);
    }
  }

  /** Состояние своих устройств: индикаторы на своей плитке и `media:state` остальным (FR-16). */
  #publishLocalMedia() {
    const state = this.#media.getMediaState();
    this.#dispatch({
      type: ACTIONS.LOCAL_MEDIA,
      local: {
        ...state,
        audioStatus: this.#media.getStatus('audio'),
        videoStatus: this.#media.getStatus('video'),
      },
    });
    this.#signaling.sendMediaState(state);
  }

  #notifyDeviceError(kind, status) {
    const message = deviceErrorMessage(kind, status);
    if (message !== null) showToast(message);
  }

  /**
   * Обрыв соединения (FR-31, TDD §7.6): переподключения нет, сессия закончилась. Выход по
   * кнопке сюда не попадает — там причина `io client disconnect`, а `LEFT` уже отправлен.
   */
  #handleDisconnected({ byClient }) {
    if (byClient || !this.#inRoom) return;
    this.#inRoom = false;
    this.#started = false;
    this.#cleanup();
    this.#dispatch({ type: ACTIONS.CONNECTION_LOST });
  }

  /** Экран ошибки входа: следующий `start` разрешён — это «Повторить вход» (TDD §4.1.2). */
  #fail(code) {
    this.#started = false;
    // Страница уже размонтирована (в StrictMode это обычный прогон эффектов) — состояния нет.
    if (this.#destroyed) return;
    this.#dispatch({ type: ACTIONS.JOIN_FAILED, error: code });
  }

  /** Конец сессии: подписки, P2P-соединения и устройства освобождаются вместе (TDD §7.6). */
  #cleanup() {
    for (const unsubscribe of this.#unsubscribes.splice(0)) unsubscribe();
    this.#mesh?.closeAll();
    this.#mesh = null;
    // `dispose` останавливает дорожки: аппаратный индикатор камеры гаснет и при выходе.
    this.#media?.dispose();
    this.#media = null;
  }
}
