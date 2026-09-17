// Индикаторы микрофона и камеры участника (TDD §6.3, §6.4, §7.4; FR-15, FR-16, FR-18).
import { SERVER_EVENTS } from '@vcr/shared';
import { validate } from '../validatePayload.js';

/** @typedef {import('../registerHandlers.js').HandlerContext} HandlerContext */

/**
 * `media:state`: ответа у события нет. Вне комнаты, при неверной форме payload и сверх лимита
 * событие молча игнорируется (TDD §6.3, §10.4). Состояние запоминается для ack тех, кто войдёт
 * позже, и рассылается комнате, кроме отправителя.
 * @param {HandlerContext} context
 * @param {unknown} payload
 */
export function handleMediaState({ socket, roomManager, rateLimiter }, payload) {
  const { participantId, roomId } = socket.data;
  if (participantId === null) return;

  const parsed = validate('media', payload);
  if (!parsed.ok) return;
  if (!rateLimiter.consume(socket.id, 'media')) return;

  const { audio, video } = parsed.value;
  roomManager.setMediaState(participantId, { audio, video });
  socket.to(roomId).emit(SERVER_EVENTS.PARTICIPANT_MEDIA, { participantId, audio, video });
}
