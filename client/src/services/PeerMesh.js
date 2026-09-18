// Реестр P2P-соединений комнаты (TDD §3.2, §4.1.3, §7.2): по одному `PeerLink` на участника.
//
// Роль задаётся порядком входа: новичок получает в ack снимок комнаты и шлёт offer каждому,
// остальные только отвечают на входящий offer. Поэтому встречных offer не бывает и паттерн
// perfect negotiation не нужен (TDD §3.2).
import { PEER_ROLES, PeerLink } from './PeerLink.js';

/** @typedef {import('./MediaManager.js').TrackKind} TrackKind */
/** @typedef {import('@vcr/shared').SignalData} SignalData */

/**
 * @param {string} peerId
 * @param {'offerer'|'answerer'} role
 * @param {import('./PeerLink.js').PeerLinkDeps} deps
 */
function defaultCreateLink(peerId, role, deps) {
  return role === PEER_ROLES.OFFERER
    ? PeerLink.createOfferer(peerId, deps)
    : PeerLink.createAnswerer(peerId, deps);
}

export class PeerMesh {
  /** @type {Map<string, PeerLink>} */
  #links = new Map();
  /** Участники, которых уже нет в комнате: их поздние сигналы игнорируются (TDD §7.2, п. 2). */
  #departed = new Set();
  /** @type {Set<(peerId: string, status: string) => void>} */
  #statusHandlers = new Set();
  #linkDeps;
  #createLink;
  #closed = false;

  /**
   * @param {Object} deps
   * @param {(peerId: string, data: SignalData) => void} deps.sendSignal
   * @param {RTCIceServer[]} [deps.iceServers]  из ack `room:join`
   * @param {(kind: TrackKind) => MediaStreamTrack|null} [deps.getLocalTrack]
   * @param {typeof defaultCreateLink} [deps.createLink]  в тестах — фабрика-мок
   */
  constructor({ sendSignal, iceServers = [], getLocalTrack = () => null, createLink }) {
    this.#linkDeps = { sendSignal, iceServers, getLocalTrack };
    this.#createLink = createLink ?? defaultCreateLink;
  }

  /** @returns {string[]} пиры с открытым соединением — порядок создания */
  get peerIds() {
    return [...this.#links.keys()];
  }

  /**
   * Снимок участников из ack `room:join`: мы вошли последними, значит offer за нами (TDD §3.2).
   * Вызывается сразу после входа, не дожидаясь захвата устройств (TDD §7.2).
   * @param {string[]} peerIds
   */
  connectTo(peerIds) {
    if (this.#closed) return;
    for (const peerId of peerIds) {
      if (this.#links.has(peerId)) continue;
      // Промис не ждём: offer уходит сам, а об ошибке сообщит статус пары.
      this.#open(peerId, PEER_ROLES.OFFERER).start();
    }
  }

  /**
   * Входящий `signal` от участника (TDD §6.4, §7.2).
   * @param {string} from  participantId отправителя; его проставляет сервер
   * @param {SignalData} data
   * @returns {Promise<void>}
   */
  async handleSignal(from, data) {
    if (this.#closed || this.#departed.has(from)) return;

    const existing = this.#links.get(from);
    if (existing === undefined) {
      // Первым делом от нового участника приходит offer — отвечаем на него (TDD §3.2).
      if (data?.type !== 'offer') return;
      await this.#open(from, PEER_ROLES.ANSWERER).handleSignal(data);
      return;
    }

    // Повторный offer по протоколу невозможен, но обрабатывается защитно: старую пару
    // закрываем и отвечаем заново (TDD §7.2, правило 3).
    if (data?.type === 'offer') {
      existing.close();
      this.#links.delete(from);
      await this.#open(from, PEER_ROLES.ANSWERER).handleSignal(data);
      return;
    }

    await existing.handleSignal(data);
  }

  /**
   * Участник вышел (FR-27) или сервер ответил `PEER_NOT_FOUND`: соединение больше не нужно,
   * а его поздние сигналы нужно игнорировать.
   * @param {string} peerId
   */
  removePeer(peerId) {
    this.#departed.add(peerId);
    const link = this.#links.get(peerId);
    if (link === undefined) return;
    this.#links.delete(peerId);
    link.close();
  }

  /**
   * Новая локальная дорожка — всем пирам разом, без повторного согласования (TDD §7.4).
   * Пары, созданные позже, возьмут текущую дорожку сами через `getLocalTrack`.
   * @param {TrackKind} kind
   * @param {MediaStreamTrack|null} track
   */
  broadcastTrack(kind, track) {
    for (const link of this.#links.values()) link.replaceTrack(kind, track);
  }

  /**
   * @param {string} peerId
   * @returns {MediaStream|null} поток пира для его плитки
   */
  getStream(peerId) {
    return this.#links.get(peerId)?.remoteStream ?? null;
  }

  /**
   * Статусы пар для плиток и диагностики (TDD §4.1.6, §11.4).
   * @returns {Record<string, string>}
   */
  getStatuses() {
    return Object.fromEntries([...this.#links].map(([peerId, link]) => [peerId, link.status]));
  }

  /**
   * @param {(peerId: string, status: string) => void} handler
   * @returns {() => void} отписка
   */
  onStatus(handler) {
    this.#statusHandlers.add(handler);
    return () => this.#statusHandlers.delete(handler);
  }

  /** Конец сессии: выход, обрыв связи, размонтирование страницы (TDD §7.6). */
  closeAll() {
    this.#closed = true;
    for (const link of this.#links.values()) link.close();
    this.#links.clear();
    this.#statusHandlers.clear();
  }

  /**
   * @param {string} peerId
   * @param {'offerer'|'answerer'} role
   */
  #open(peerId, role) {
    const link = this.#createLink(peerId, role, this.#linkDeps);
    this.#links.set(peerId, link);
    link.onStatus((status) => this.#emitStatus(peerId, status));
    // Начальный `connecting`: плитка пира появляется сразу, ещё до обмена SDP.
    this.#emitStatus(peerId, link.status);
    return link;
  }

  #emitStatus(peerId, status) {
    // Копия: обработчик вправе отписаться прямо во время вызова.
    for (const handler of [...this.#statusHandlers]) handler(peerId, status);
  }
}
