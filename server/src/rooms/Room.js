// Комната: участники в порядке входа и ограниченная история чата (TDD §4.2.1, §5.2).
import { CHAT_HISTORY_LIMIT } from '@vcr/shared';

/** @typedef {import('@vcr/shared').ChatMessage} ChatMessage */
/** @typedef {import('@vcr/shared').ParticipantDTO} ParticipantDTO */

/**
 * Участник комнаты на сервере (TDD §5.2). Клиентам отдаётся только `ParticipantDTO`.
 * @typedef {Object} Participant
 * @property {string}  id        // crypto.randomUUID(); в UI не показывается (FR-30)
 * @property {string}  socketId
 * @property {string}  name      // нормализованное, валидное имя (TDD §4.3)
 * @property {boolean} audio     // индикатор микрофона (сообщает клиент)
 * @property {boolean} video     // индикатор камеры
 * @property {number}  joinedAt  // epoch ms
 */

/**
 * Участник в том виде, в каком его видят другие клиенты: без `socketId` и `joinedAt`.
 * @param {Participant} participant
 * @returns {ParticipantDTO}
 */
export function toParticipantDTO({ id, name, audio, video }) {
  return { id, name, audio, video };
}

export class Room {
  /**
   * Порядок вставки `Map` — порядок входа (FR-26). Изменяется только методами `Room`.
   * @type {Map<string, Participant>}
   */
  participants = new Map();

  /** Кольцевой буфер истории: при переполнении новое сообщение занимает место самого старого. */
  #messages = [];
  /** Индекс самого старого сообщения в `#messages`. */
  #oldest = 0;
  #historyLimit;

  /**
   * @param {string} id
   * @param {{ historyLimit?: number }} [options]  размер истории, по умолчанию `CHAT_HISTORY_LIMIT`
   */
  constructor(id, { historyLimit = CHAT_HISTORY_LIMIT } = {}) {
    if (!Number.isInteger(historyLimit) || historyLimit < 1) {
      throw new RangeError(`historyLimit должен быть целым числом ≥ 1, получено: ${historyLimit}`);
    }
    this.id = id;
    this.createdAt = Date.now();
    this.#historyLimit = historyLimit;
  }

  /** Число участников. */
  get size() {
    return this.participants.size;
  }

  /** @param {string} participantId */
  has(participantId) {
    return this.participants.has(participantId);
  }

  /**
   * @param {string} participantId
   * @returns {Participant | null}
   */
  get(participantId) {
    return this.participants.get(participantId) ?? null;
  }

  /**
   * Добавляет участника в конец списка. Лимит участников проверяет `RoomManager`.
   * @param {Participant} participant
   */
  add(participant) {
    if (this.participants.has(participant.id)) {
      throw new Error(`Участник ${participant.id} уже в комнате ${this.id}`);
    }
    this.participants.set(participant.id, participant);
  }

  /**
   * @param {string} participantId
   * @returns {Participant | null}  удалённый участник или `null`, если его не было
   */
  remove(participantId) {
    const participant = this.participants.get(participantId);
    if (!participant) return null;
    this.participants.delete(participantId);
    return participant;
  }

  /**
   * Добавляет сообщение в историю; если история заполнена, вытесняет самое старое (FR-23).
   * @param {ChatMessage} message
   */
  pushMessage(message) {
    if (this.#messages.length < this.#historyLimit) {
      this.#messages.push(message);
      return;
    }
    this.#messages[this.#oldest] = message;
    this.#oldest = (this.#oldest + 1) % this.#historyLimit;
  }

  /**
   * Снимок комнаты для ack `room:join` (TDD §6.3): участники в порядке входа и история от старых
   * сообщений к новым. Массивы новые, изменение снимка не затрагивает комнату.
   * @param {string} [excludePid]  участник, которого не включать в список (сам вошедший)
   * @returns {{ participants: ParticipantDTO[], messages: ChatMessage[] }}
   */
  snapshot(excludePid) {
    const participants = [];
    for (const participant of this.participants.values()) {
      if (participant.id !== excludePid) participants.push(toParticipantDTO(participant));
    }
    const messages = [
      ...this.#messages.slice(this.#oldest),
      ...this.#messages.slice(0, this.#oldest),
    ];
    return { participants, messages };
  }
}
