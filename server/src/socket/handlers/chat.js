// Сообщения чата (TDD §6.3, §6.4, §7.5, §10.3).
import { ERROR_CODES, SERVER_EVENTS, validateMessage } from '@vcr/shared';
import { validate } from '../validatePayload.js';

/** @typedef {import('../registerHandlers.js').HandlerContext} HandlerContext */
/** @typedef {import('../registerHandlers.js').Reply} Reply */

/**
 * `chat:send`: только участник комнаты → форма payload → rate limit → текст → история → ack автору
 * и рассылка всей комнате, включая автора: клиент убирает дубль по `message.id` (TDD §6.4).
 * Комната берётся из `socket.data`, а не из payload (TDD §10.1). Текст не экранируется: клиент
 * выводит его только текстовым узлом.
 * @param {HandlerContext} context
 * @param {unknown} payload
 * @param {Reply} reply
 */
export function handleChatSend({ socket, io, roomManager, rateLimiter }, payload, reply) {
  const { participantId, roomId } = socket.data;
  if (participantId === null) return reply.error(ERROR_CODES.NOT_IN_ROOM);

  const parsed = validate('chat', payload);
  if (!parsed.ok) return reply.error(parsed.code);
  if (!rateLimiter.consume(socket.id, 'chat')) return reply.error(ERROR_CODES.RATE_LIMITED);
  const text = validateMessage(parsed.value.text);
  if (!text.ok) return reply.error(text.code);

  const message = roomManager.addChatMessage(participantId, text.value);
  reply.ok({ message });
  io.to(roomId).emit(SERVER_EVENTS.CHAT_MESSAGE, { message });
}
