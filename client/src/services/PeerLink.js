// Одно P2P-соединение с одним участником комнаты (TDD §3.2, §4.1.4, §7.2).
//
// Согласование проходит ровно один раз на пару: offer шлёт тот, кто вошёл позже, остальные
// только отвечают. Поэтому glare невозможен по построению, `onnegotiationneeded` не нужен, а
// смена локальных дорожек идёт через `replaceTrack` без нового SDP (TDD §3.2, §4.1.4).
import { LINK_STATUS } from '../state/roomReducer.js';

/** Не дошли до `connected` за это время — пара не состоялась (FR-34, TDD §7.2, правило 4). */
export const PEER_CONNECT_TIMEOUT_MS = 15_000;

/** Роль в согласовании: кто шлёт offer, а кто отвечает (TDD §3.2). */
export const PEER_ROLES = Object.freeze({ OFFERER: 'offerer', ANSWERER: 'answerer' });

/** Виды трансиверов; порядок важен — он задаёт порядок m-строк в SDP. */
const KINDS = Object.freeze(['audio', 'video']);

/** @typedef {import('./MediaManager.js').TrackKind} TrackKind */
/** @typedef {import('@vcr/shared').SignalData} SignalData */

/**
 * @typedef {Object} PeerLinkDeps
 * @property {(peerId: string, data: SignalData) => void} sendSignal
 * @property {RTCIceServer[]} [iceServers]  из ack `room:join` (TDD §6.3)
 * @property {(kind: TrackKind) => MediaStreamTrack|null} [getLocalTrack]
 * @property {(configuration: RTCConfiguration) => RTCPeerConnection} [createPeerConnection]
 * @property {(tracks: MediaStreamTrack[]) => MediaStream} [createMediaStream]
 * @property {number} [connectTimeoutMs]
 */

function defaultCreatePeerConnection(configuration) {
  return new RTCPeerConnection(configuration);
}

function defaultCreateMediaStream(tracks) {
  return new MediaStream(tracks);
}

/** Кандидат уходит на сервер как обычный JSON: `RTCIceCandidate` там не пройдёт проверку формы. */
function toCandidateInit(candidate) {
  if (candidate === null || candidate === undefined) return null;
  return candidate.toJSON?.() ?? candidate;
}

export class PeerLink {
  /**
   * Мы вошли позже пира: инициатива за нами (TDD §3.2). Обмен начинает `start()`.
   * @param {string} peerId
   * @param {PeerLinkDeps} deps
   */
  static createOfferer(peerId, deps) {
    return new PeerLink(peerId, PEER_ROLES.OFFERER, deps);
  }

  /**
   * Пир вошёл позже нас и прислал offer: отвечаем. Сам offer передаётся в `handleSignal`.
   * @param {string} peerId
   * @param {PeerLinkDeps} deps
   */
  static createAnswerer(peerId, deps) {
    return new PeerLink(peerId, PEER_ROLES.ANSWERER, deps);
  }

  #sendSignal;
  #getLocalTrack;
  #createMediaStream;
  /** @type {RTCPeerConnection} */
  #pc;
  /** @type {Record<TrackKind, RTCRtpTransceiver|null>} */
  #transceivers = { audio: null, video: null };
  /** Кандидаты, пришедшие до `setRemoteDescription` (TDD §7.2, правило 1). */
  #pendingCandidates = [];
  #remoteApplied = false;
  #remoteStream = null;
  #status = LINK_STATUS.CONNECTING;
  /** @type {Set<(status: string) => void>} */
  #statusHandlers = new Set();
  #timer;
  #started = false;
  #closed = false;
  #lastError = null;

  /**
   * @param {string} peerId
   * @param {'offerer'|'answerer'} role
   * @param {PeerLinkDeps} deps
   */
  constructor(
    peerId,
    role,
    {
      sendSignal,
      iceServers = [],
      getLocalTrack = () => null,
      createPeerConnection = defaultCreatePeerConnection,
      createMediaStream = defaultCreateMediaStream,
      connectTimeoutMs = PEER_CONNECT_TIMEOUT_MS,
    },
  ) {
    this.peerId = peerId;
    this.role = role;
    this.#sendSignal = sendSignal;
    this.#getLocalTrack = getLocalTrack;
    this.#createMediaStream = createMediaStream;

    this.#pc = createPeerConnection({ iceServers });
    this.#pc.onicecandidate = (event) => this.#handleLocalCandidate(event);
    this.#pc.onconnectionstatechange = () => this.#handleConnectionState();
    // `onnegotiationneeded` намеренно не подписан: второго согласования в протоколе нет.
    this.#timer = setTimeout(() => this.#handleTimeout(), connectTimeoutMs);
  }

  /** @returns {string} одно из `LINK_STATUS` */
  get status() {
    return this.#status;
  }

  /** @returns {MediaStream|null} поток пира; появляется сразу после `setRemoteDescription` */
  get remoteStream() {
    return this.#remoteStream;
  }

  /** @returns {unknown} последняя ошибка согласования — для диагностики (TDD §11.4) */
  get lastError() {
    return this.#lastError;
  }

  /**
   * Начало согласования у offerer: трансиверы, текущие локальные дорожки и один offer.
   * Диалог разрешений при этом не ждут — дорожки доедут через `replaceTrack` (TDD §7.2).
   * @returns {Promise<void>}
   */
  async start() {
    if (this.role !== PEER_ROLES.OFFERER || this.#started || this.#closed) return;
    this.#started = true;
    try {
      for (const kind of KINDS) {
        const transceiver = this.#pc.addTransceiver(kind, { direction: 'sendrecv' });
        this.#transceivers[kind] = transceiver;
        await transceiver.sender.replaceTrack(this.#getLocalTrack(kind) ?? null);
      }
      const offer = await this.#pc.createOffer();
      await this.#pc.setLocalDescription(offer);
      this.#send({ type: 'offer', sdp: offer.sdp });
    } catch (error) {
      this.#fail(error);
    }
  }

  /**
   * Входящий сигнал от пира: offer, answer или ICE-кандидат (TDD §6.3, §7.2).
   * @param {SignalData} data
   * @returns {Promise<void>}
   */
  async handleSignal(data) {
    if (this.#closed) return;
    try {
      if (data?.type === 'offer') await this.#acceptOffer(data);
      else if (data?.type === 'answer') await this.#acceptAnswer(data);
      else if (data?.type === 'candidate') await this.#acceptCandidate(data.candidate ?? null);
    } catch (error) {
      this.#fail(error);
    }
  }

  /**
   * Новая локальная дорожка для пира — без повторного согласования (TDD §4.1.4, §7.4).
   * Пока трансиверов нет, делать нечего: при их создании дорожка берётся заново.
   * @param {TrackKind} kind
   * @param {MediaStreamTrack|null} track
   * @returns {Promise<void>}
   */
  async replaceTrack(kind, track) {
    const sender = this.#transceivers[kind]?.sender;
    if (!sender || this.#closed) return;
    try {
      await sender.replaceTrack(track ?? null);
    } catch {
      // Пара из-за одной дорожки не разваливается: остальное продолжает работать.
    }
  }

  /**
   * @param {(status: string) => void} handler
   * @returns {() => void} отписка
   */
  onStatus(handler) {
    this.#statusHandlers.add(handler);
    return () => this.#statusHandlers.delete(handler);
  }

  /**
   * Закрытие: пир вышел, комната покидается или соединение пересоздаётся. О смене статуса
   * никого не уведомляем — закрытие инициируем мы сами, и тот, кто закрыл, об этом знает.
   */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#timer);
    this.#pc.onicecandidate = null;
    this.#pc.onconnectionstatechange = null;
    this.#pendingCandidates.length = 0;
    this.#status = LINK_STATUS.CLOSED;
    this.#statusHandlers.clear();
    this.#pc.close();
  }

  /** Ответ на offer (TDD §4.1.4): описание → трансиверы `sendrecv` с дорожками → answer. */
  async #acceptOffer(offer) {
    if (this.role !== PEER_ROLES.ANSWERER || this.#remoteApplied) return;
    await this.#pc.setRemoteDescription(offer);
    this.#remoteApplied = true;

    for (const transceiver of this.#pc.getTransceivers()) {
      // Вид трансивера определяется по дорожке приёмника: своих дорожек в нём ещё нет.
      const kind = transceiver.receiver?.track?.kind;
      if (!KINDS.includes(kind)) continue;
      transceiver.direction = 'sendrecv';
      this.#transceivers[kind] = transceiver;
      await transceiver.sender.replaceTrack(this.#getLocalTrack(kind) ?? null);
    }

    const answer = await this.#pc.createAnswer();
    await this.#pc.setLocalDescription(answer);
    this.#send({ type: 'answer', sdp: answer.sdp });
    this.#adoptRemoteStream();
    await this.#flushCandidates();
  }

  async #acceptAnswer(answer) {
    if (this.role !== PEER_ROLES.OFFERER || this.#remoteApplied) return;
    await this.#pc.setRemoteDescription(answer);
    this.#remoteApplied = true;
    this.#adoptRemoteStream();
    await this.#flushCandidates();
  }

  /** @param {RTCIceCandidateInit|null} init */
  async #acceptCandidate(init) {
    // До описания кандидата добавить нельзя — ждём в очереди (TDD §7.2, правило 1).
    if (!this.#remoteApplied) {
      this.#pendingCandidates.push(init);
      return;
    }
    await this.#addIceCandidate(init);
  }

  async #flushCandidates() {
    for (const init of this.#pendingCandidates.splice(0)) await this.#addIceCandidate(init);
  }

  /** @param {RTCIceCandidateInit|null} init */
  async #addIceCandidate(init) {
    try {
      // `null` — end-of-candidates: вызов без аргумента (TDD §6.3).
      await this.#pc.addIceCandidate(init ?? undefined);
    } catch {
      // Отдельный кандидат может не примениться; остальные всё равно стоит попробовать.
    }
  }

  /**
   * Поток пира собирается из приёмников: он есть сразу после `setRemoteDescription`,
   * ждать `ontrack` не нужно (TDD §4.1.4).
   */
  #adoptRemoteStream() {
    const tracks = this.#pc
      .getReceivers()
      .map((receiver) => receiver.track)
      .filter((track) => track !== null && track !== undefined);
    this.#remoteStream = this.#createMediaStream(tracks);
  }

  #handleLocalCandidate(event) {
    this.#send({ type: 'candidate', candidate: toCandidateInit(event?.candidate) });
  }

  #handleConnectionState() {
    const state = this.#pc.connectionState;
    // `disconnected` — временная потеря: ICE восстанавливается сам, статус не трогаем.
    if (state === 'connected') this.#settle(LINK_STATUS.CONNECTED);
    else if (state === 'failed') this.#settle(LINK_STATUS.FAILED);
  }

  #handleTimeout() {
    if (this.#status === LINK_STATUS.CONNECTED) return;
    this.#settle(LINK_STATUS.FAILED);
  }

  #fail(error) {
    this.#lastError = error;
    this.#settle(LINK_STATUS.FAILED);
  }

  /** @param {string} status */
  #settle(status) {
    clearTimeout(this.#timer);
    if (this.#closed || this.#status === status) return;
    this.#status = status;
    // Копия: обработчик вправе отписаться прямо во время вызова.
    for (const handler of [...this.#statusHandlers]) handler(status);
  }

  /** @param {SignalData} data */
  #send(data) {
    if (this.#closed) return;
    this.#sendSignal(this.peerId, data);
  }
}
