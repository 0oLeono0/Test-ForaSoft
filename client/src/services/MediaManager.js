// Локальные камера и микрофон (TDD §4.1.3, §4.1.4): первичный захват с частичным успехом,
// тумблеры без повторного согласования SDP и отслеживание пропавших устройств.
//
// Захват намеренно отделён от mesh: `PeerLink` получает дорожки через `replaceTrack`, поэтому
// разрешения можно спрашивать уже после того, как offer ушёл (TDD §7.2).
import { TRACK_STATUS, mapMediaError } from '../utils/mediaErrors.js';

/**
 * Компромисс нагрузки на CPU: при четырёх участниках клиент кодирует три исходящих потока
 * (TDD §4.1.4, §9.2).
 */
export const VIDEO_CONSTRAINTS = Object.freeze({
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 24, max: 30 },
});

/** Виды локальных дорожек в том же написании, что и ключи `MediaStreamConstraints`. */
export const TRACK_KINDS = Object.freeze(['audio', 'video']);

/** Вид дорожки → вид устройства в `enumerateDevices()`. */
const DEVICE_KIND = Object.freeze({ audio: 'audioinput', video: 'videoinput' });

/** @typedef {import('../utils/mediaErrors.js').TrackStatus} TrackStatus */
/** @typedef {'audio'|'video'} TrackKind */
/** @typedef {{ status: TrackStatus, track: MediaStreamTrack|null }} TrackResult */
/** @typedef {{ audio: TrackResult, video: TrackResult }} AcquireResult */

/** Устройства нет в системе — запрашивать нечего (TDD §4.1.4, шаг 1). */
function notFound() {
  return { status: TRACK_STATUS.NOT_FOUND, track: null };
}

/**
 * Разбор успешного `getUserMedia`: по дорожке на каждый запрошенный вид. Ответ без дорожки
 * запрошенного вида контракту не соответствует — считаем это ошибкой, а не отсутствием устройства.
 * @param {MediaStream} stream
 * @param {TrackKind[]} kinds
 * @returns {Record<TrackKind, TrackResult>}
 */
function splitStream(stream, kinds) {
  const results = {};
  for (const kind of kinds) {
    const track = stream.getTracks().find((candidate) => candidate.kind === kind) ?? null;
    results[kind] =
      track === null
        ? { status: TRACK_STATUS.ERROR, track: null }
        : { status: TRACK_STATUS.OK, track };
  }
  return results;
}

export class MediaManager {
  #mediaDevices;
  #createMediaStream;
  /** @type {Record<TrackKind, MediaStreamTrack|null>} */
  #tracks = { audio: null, video: null };
  /** @type {Record<TrackKind, TrackStatus|null>} */
  #statuses = { audio: null, video: null };
  /** @type {MediaStream|null} поток своей плитки; живёт до конца сессии */
  #localStream = null;
  /** @type {Set<(kind: TrackKind, track: MediaStreamTrack|null) => void>} */
  #trackChangeHandlers = new Set();
  /** @type {Set<(kind: TrackKind) => void>} */
  #deviceLostHandlers = new Set();
  #disposed = false;

  /**
   * @param {Object} [deps]
   * @param {MediaDevices} [deps.mediaDevices]  в тестах — мок с `enumerateDevices`/`getUserMedia`
   * @param {(tracks: MediaStreamTrack[]) => MediaStream} [deps.createMediaStream]
   */
  constructor({ mediaDevices, createMediaStream } = {}) {
    this.#mediaDevices = mediaDevices ?? navigator.mediaDevices;
    this.#createMediaStream = createMediaStream ?? ((tracks) => new MediaStream(tracks));
  }

  /**
   * Поток для своей плитки (TDD §4.1.5). Объект один на всю сессию, а дорожки в нём меняются:
   * так `<video>` не приходится перепривязывать на каждый щелчок тумблера.
   * @returns {MediaStream}
   */
  get localStream() {
    if (this.#localStream === null) {
      const tracks = TRACK_KINDS.map((kind) => this.#tracks[kind]).filter(
        (track) => track !== null,
      );
      this.#localStream = this.#createMediaStream(tracks);
    }
    return this.#localStream;
  }

  /**
   * Первичный захват (FR-13, FR-14, FR-33, TDD §4.1.4). Не отклоняется: отказ в доступе и
   * занятая камера — это статус дорожки, а не повод не пускать в комнату.
   * @returns {Promise<AcquireResult>}
   */
  async acquire() {
    const available = await this.#detectDevices();
    const wanted = TRACK_KINDS.filter((kind) => available[kind]);

    /** @type {AcquireResult} */
    const result = { audio: notFound(), video: notFound() };
    // Без единого запрошенного вида `getUserMedia` выбрасывает TypeError — звать его незачем.
    if (wanted.length > 0) Object.assign(result, await this.#capture(wanted));

    for (const kind of TRACK_KINDS) {
      this.#statuses[kind] = result[kind].status;
      // Сессия закончилась, пока шёл диалог разрешений: дорожки нужно освободить сразу.
      if (this.#disposed) result[kind].track?.stop();
      else this.#setTrack(kind, result[kind].track);
    }
    return result;
  }

  /**
   * Тумблер микрофона (FR-15, TDD §4.1.4). Выключение оставляет дорожку живой и передаёт пирам
   * тишину: повторное согласование SDP не нужно, а индикатор у остальных гасит `media:state`.
   * Если дорожки нет (отказ, устройство потеряно), включение пробует захватить её заново.
   * @param {boolean} enabled
   * @returns {Promise<TrackStatus|null>}  итоговый статус устройства (`null` — захвата не было)
   */
  async setAudioEnabled(enabled) {
    const track = this.#tracks.audio;
    if (track !== null) {
      track.enabled = enabled;
      return this.#statuses.audio;
    }
    if (!enabled || this.#disposed) return this.#statuses.audio;
    return this.#recapture('audio');
  }

  /**
   * Тумблер камеры (FR-17, FR-19, TDD §4.1.4, §7.4). Выключение останавливает дорожку —
   * только так гаснет аппаратный индикатор; включение захватывает новую.
   * @param {boolean} enabled
   * @returns {Promise<TrackStatus|null>}  `OK` — камера включена, иначе причина отказа (§8.2)
   */
  async setVideoEnabled(enabled) {
    if (!enabled) {
      if (this.#tracks.video !== null) {
        this.#stopTrack('video');
        this.#emitTrackChange('video', null);
      }
      return this.#statuses.video;
    }
    if (this.#tracks.video !== null || this.#disposed) return this.#statuses.video;
    return this.#recapture('video');
  }

  /**
   * @param {TrackKind} kind
   * @returns {MediaStreamTrack|null}
   */
  getTrack(kind) {
    return this.#tracks[kind] ?? null;
  }

  /**
   * Почему дорожки нет: статус показывает подсказку на кнопке устройства (TDD §8.2).
   * @param {TrackKind} kind
   * @returns {TrackStatus|null}  `null` — захват ещё не выполнялся
   */
  getStatus(kind) {
    return this.#statuses[kind] ?? null;
  }

  /**
   * Состояние тумблеров для `media:state` и своей плитки (TDD §6.3). Микрофон выключается
   * флагом `enabled`, камера — остановкой дорожки, поэтому проверки разные.
   * @returns {{ audio: boolean, video: boolean }}
   */
  getMediaState() {
    return {
      audio: this.#tracks.audio !== null && this.#tracks.audio.enabled !== false,
      video: this.#tracks.video !== null,
    };
  }

  /**
   * Новая локальная дорожка (или её исчезновение) — для `PeerMesh.broadcastTrack` (TDD §7.4).
   * @param {(kind: TrackKind, track: MediaStreamTrack|null) => void} handler
   * @returns {() => void} отписка
   */
  onTrackChange(handler) {
    this.#trackChangeHandlers.add(handler);
    return () => this.#trackChangeHandlers.delete(handler);
  }

  /**
   * Устройство пропало во время звонка (FR-20, TDD §8.2): отключили камеру, выдернули гарнитуру.
   * @param {(kind: TrackKind) => void} handler
   * @returns {() => void} отписка
   */
  onDeviceLost(handler) {
    this.#deviceLostHandlers.add(handler);
    return () => this.#deviceLostHandlers.delete(handler);
  }

  /** Конец сессии (TDD §7.6): дорожки останавливаются, поздние колбэки уже никому не нужны. */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const kind of TRACK_KINDS) this.#stopTrack(kind);
    this.#trackChangeHandlers.clear();
    this.#deviceLostHandlers.clear();
  }

  /** Список устройств: отсутствующий вид не запрашивается и считается `NOT_FOUND`. */
  async #detectDevices() {
    try {
      const devices = await this.#mediaDevices.enumerateDevices();
      return {
        audio: devices.some((device) => device.kind === DEVICE_KIND.audio),
        video: devices.some((device) => device.kind === DEVICE_KIND.video),
      };
    } catch {
      // Перечислить устройства не вышло — пусть решает сам `getUserMedia`.
      return { audio: true, video: true };
    }
  }

  /**
   * Один запрос на оба вида, а при ошибке — по отдельности: камера, занятая другим
   * приложением, не должна отнимать микрофон (TDD §4.1.4, шаг 3).
   * @param {TrackKind[]} kinds
   */
  async #capture(kinds) {
    try {
      const stream = await this.#getUserMedia(kinds);
      return splitStream(stream, kinds);
    } catch (error) {
      if (kinds.length === 1) {
        return { [kinds[0]]: { status: mapMediaError(error), track: null } };
      }
      const results = {};
      // Последовательно: два диалога разрешений одновременно сбивают с толку.
      for (const kind of kinds) results[kind] = await this.#captureOne(kind);
      return results;
    }
  }

  /**
   * Повторный захват по нажатию тумблера. Неудача состояние не меняет: дорожки как не было,
   * так и нет, а причину покажет toast (TDD §7.4).
   * @param {TrackKind} kind
   * @returns {Promise<TrackStatus>}
   */
  async #recapture(kind) {
    const { status, track } = await this.#captureOne(kind);
    this.#statuses[kind] = status;
    if (track === null) return status;
    // `dispose` во время диалога разрешений: дорожка родилась уже ненужной.
    if (this.#disposed) {
      track.stop();
      return status;
    }
    this.#setTrack(kind, track);
    this.#emitTrackChange(kind, track);
    return status;
  }

  /**
   * @param {TrackKind} kind
   * @returns {Promise<TrackResult>}
   */
  async #captureOne(kind) {
    try {
      const stream = await this.#getUserMedia([kind]);
      return splitStream(stream, [kind])[kind];
    } catch (error) {
      return { status: mapMediaError(error), track: null };
    }
  }

  /** @param {TrackKind[]} kinds */
  #getUserMedia(kinds) {
    const constraints = {};
    for (const kind of kinds) constraints[kind] = kind === 'video' ? VIDEO_CONSTRAINTS : true;
    return this.#mediaDevices.getUserMedia(constraints);
  }

  /**
   * @param {TrackKind} kind
   * @param {MediaStreamTrack|null} track
   */
  #setTrack(kind, track) {
    const previous = this.#tracks[kind];
    // Дорожку заменяем осознанно — её `ended` больше не новость.
    if (previous !== null && previous !== track) previous.onended = null;
    this.#tracks[kind] = track;
    if (track !== null) track.onended = () => this.#handleDeviceLost(kind, track);
    this.#syncLocalStream(kind, track);
  }

  /** @param {TrackKind} kind */
  #stopTrack(kind) {
    const track = this.#tracks[kind];
    if (track === null) return;
    track.onended = null;
    track.stop();
    this.#tracks[kind] = null;
    this.#syncLocalStream(kind, null);
  }

  /**
   * Своя плитка показывает ровно текущие дорожки: остановленную видеодорожку нужно убрать,
   * иначе `<video>` замрёт на последнем кадре вместо силуэта.
   * @param {TrackKind} kind
   * @param {MediaStreamTrack|null} track
   */
  #syncLocalStream(kind, track) {
    // Потока ещё не спрашивали — он соберётся из текущих дорожек при первом обращении.
    if (this.#localStream === null) return;
    for (const existing of this.#localStream.getTracks()) {
      if (existing.kind === kind) this.#localStream.removeTrack(existing);
    }
    if (track !== null) this.#localStream.addTrack(track);
  }

  /**
   * Устройство пропало само (FR-20). Статус остаётся прежним: устройство могли вернуть на
   * место, и кнопка должна остаться доступной для повторной попытки.
   * @param {TrackKind} kind
   * @param {MediaStreamTrack} track  дорожка, которая закончилась; её могли уже заменить
   */
  #handleDeviceLost(kind, track) {
    if (this.#tracks[kind] !== track) return;
    track.onended = null;
    this.#tracks[kind] = null;
    this.#syncLocalStream(kind, null);
    this.#emitTrackChange(kind, null);
    for (const handler of [...this.#deviceLostHandlers]) handler(kind);
  }

  /**
   * @param {TrackKind} kind
   * @param {MediaStreamTrack|null} track
   */
  #emitTrackChange(kind, track) {
    // Копия: обработчик вправе отписаться прямо во время вызова.
    for (const handler of [...this.#trackChangeHandlers]) handler(kind, track);
  }
}
