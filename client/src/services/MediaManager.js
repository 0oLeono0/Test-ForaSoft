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
  /** @type {Record<TrackKind, MediaStreamTrack|null>} */
  #tracks = { audio: null, video: null };
  /** @type {Record<TrackKind, TrackStatus|null>} */
  #statuses = { audio: null, video: null };

  /**
   * @param {Object} [deps]
   * @param {MediaDevices} [deps.mediaDevices]  в тестах — мок с `enumerateDevices`/`getUserMedia`
   */
  constructor({ mediaDevices } = {}) {
    this.#mediaDevices = mediaDevices ?? navigator.mediaDevices;
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
      this.#setTrack(kind, result[kind].track);
    }
    return result;
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
    this.#tracks[kind] = track;
  }
}
