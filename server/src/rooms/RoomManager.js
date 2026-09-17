// Реестр комнат в памяти процесса: атомарный вход с лимитом участников, удаление пустых комнат,
// история чата и состояние индикаторов медиа (TDD §4.2.1–4.2.3, §5.2, §5.3).
//
// ИНВАРИАНТ (FR-7, TDD §4.2.2): методы RoomManager синхронны. Между проверкой лимита и вставкой
// участника нет await, промисов и колбэков, поэтому Node.js не может начать второй join, пока
// не закончился первый, и гонка за последний слот невозможна. ESLint запрещает await и
// async-функции в rooms/**. Инвариант держится только в одном процессе: без cluster (TDD §13, R-3).
import { randomUUID } from 'node:crypto';
import { CHAT_HISTORY_LIMIT, ERROR_CODES, MAX_PARTICIPANTS } from '@vcr/shared';
import { Room, toParticipantDTO } from './Room.js';

/** @typedef {import('./Room.js').Participant} Participant */
/** @typedef {import('@vcr/shared').ChatMessage} ChatMessage */
/** @typedef {import('@vcr/shared').ParticipantDTO} ParticipantDTO */

/**
 * @typedef {{ ok: true, room: Room, participant: Participant }
 *   | { ok: false, code: 'ROOM_FULL' }} JoinOutcome
 */

/**
 * @typedef {Object} LeaveOutcome
 * @property {Room}        room         // комната, из которой вышел участник
 * @property {Participant} participant  // вышедший участник
 * @property {boolean}     roomDeleted  // участник был последним: комната и история удалены (FR-9)
 */

export class RoomManager {
  /**
   * Комнаты по `roomId`. Изменяются только методами `RoomManager`.
   * @type {Map<string, Room>}
   */
  rooms = new Map();

  /**
   * `participantId` → `roomId`: выход и `disconnect` без перебора комнат.
   * @type {Map<string, string>}
   */
  byParticipant = new Map();

  #historyLimit;

  /**
   * @param {{ historyLimit?: number }} [options]  размер истории чата каждой комнаты
   */
  constructor({ historyLimit = CHAT_HISTORY_LIMIT } = {}) {
    this.#historyLimit = historyLimit;
  }

  /**
   * Добавляет участника в комнату, создавая её при первом входе (FR-5). Синхронный: см. инвариант
   * в начале файла. `roomId` и `name` должны быть уже проверены обработчиком.
   * @param {{ roomId: string, name: string, socketId: string }} params
   * @returns {JoinOutcome}
   */
  join({ roomId, name, socketId }) {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Room(roomId, { historyLimit: this.#historyLimit });
      this.rooms.set(roomId, room);
    }
    // Только что созданная комната пуста, поэтому отказ возможен только для существующей.
    if (room.size >= MAX_PARTICIPANTS) return { ok: false, code: ERROR_CODES.ROOM_FULL };

    // Флагов «создатель» нет: все участники равны (FR-32).
    const participant = {
      id: randomUUID(),
      socketId,
      name,
      audio: false,
      video: false,
      joinedAt: Date.now(),
    };
    room.add(participant);
    this.byParticipant.set(participant.id, roomId);
    return { ok: true, room, participant };
  }

  /**
   * Удаляет участника; комната, оставшаяся пустой, удаляется вместе с историей (FR-9).
   * Идемпотентный: `disconnect` после явного `room:leave` получает `null` и ничего не делает.
   * @param {string} participantId
   * @returns {LeaveOutcome | null}  `null`, если участника уже нет
   */
  leave(participantId) {
    const roomId = this.byParticipant.get(participantId);
    if (roomId === undefined) return null;

    const room = this.rooms.get(roomId);
    const participant = room.remove(participantId);
    this.byParticipant.delete(participantId);

    const roomDeleted = room.size === 0;
    if (roomDeleted) this.rooms.delete(roomId);
    return { room, participant, roomDeleted };
  }

  /**
   * @param {string} participantId
   * @returns {Room | null}  комната участника или `null`, если он не в комнате
   */
  getRoomOf(participantId) {
    const roomId = this.byParticipant.get(participantId);
    return roomId === undefined ? null : this.rooms.get(roomId);
  }

  /**
   * Сохраняет пользовательское сообщение в историю комнаты автора (FR-21, FR-23). Время ставит
   * сервер, имя автора копируется на момент отправки. Текст должен пройти `validateMessage`.
   * @param {string} participantId
   * @param {string} text
   * @returns {ChatMessage | null}  `null`, если автор не в комнате
   */
  addChatMessage(participantId, text) {
    const room = this.getRoomOf(participantId);
    if (!room) return null;
    const author = room.get(participantId);
    return this.#pushMessage(room, {
      type: 'user',
      authorId: author.id,
      authorName: author.name,
      text,
    });
  }

  /**
   * Сохраняет системное сообщение о входе или выходе (FR-25). Оно остаётся в истории и видно
   * тем, кто войдёт позже (TDD §5.3).
   * @param {string} roomId
   * @param {'joined' | 'left'} event
   * @param {string} subjectName  имя вошедшего или вышедшего участника
   * @returns {ChatMessage | null}  `null`, если комнаты уже нет
   */
  addSystemMessage(roomId, event, subjectName) {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return this.#pushMessage(room, { type: 'system', event, subjectName });
  }

  /**
   * Запоминает состояние индикаторов микрофона и камеры (FR-15, FR-16, FR-18): его получат
   * в ack участники, которые войдут позже.
   * @param {string} participantId
   * @param {{ audio: boolean, video: boolean }} state
   * @returns {Participant | null}  обновлённый участник или `null`, если он не в комнате
   */
  setMediaState(participantId, { audio, video }) {
    const participant = this.getRoomOf(participantId)?.get(participantId);
    if (!participant) return null;
    participant.audio = audio;
    participant.video = video;
    return participant;
  }

  /**
   * Счётчики для `/healthz` и интеграционных тестов (TDD §6.1, §11.3).
   * @returns {{ rooms: number, participants: number }}
   */
  stats() {
    return { rooms: this.rooms.size, participants: this.byParticipant.size };
  }

  /**
   * Участник для отправки клиентам: без `socketId` и `joinedAt`.
   * @param {Participant} participant
   * @returns {ParticipantDTO}
   */
  toDTO(participant) {
    return toParticipantDTO(participant);
  }

  /**
   * @param {Room} room
   * @param {Omit<ChatMessage, 'id' | 'ts'>} fields
   * @returns {ChatMessage}
   */
  #pushMessage(room, fields) {
    const message = { id: randomUUID(), ts: Date.now(), ...fields };
    room.pushMessage(message);
    return message;
  }
}
