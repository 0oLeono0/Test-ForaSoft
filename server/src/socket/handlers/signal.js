// Пересылка данных WebRTC-сигналинга между участниками одной комнаты (TDD §3.2, §6.3, §6.5, §10.1).
import { ERROR_CODES, SERVER_EVENTS } from '@vcr/shared';
import { PEER_ID_MAX_LENGTH, validate } from '../validatePayload.js';

/** @typedef {import('../registerHandlers.js').HandlerContext} HandlerContext */

/**
 * `signal`: ответа через ack нет, об ошибке отправитель узнаёт из `signal:error { to, code }`.
 * Сокет вне комнаты игнорируется. Далее: форма payload (INVALID_SIGNAL) → rate limit
 * (RATE_LIMITED) → получатель — другой участник той же комнаты (PEER_NOT_FOUND) → пересылка
 * только ему. `from` проставляет сервер: значение из payload отбрасывается при проверке формы.
 * @param {HandlerContext} context
 * @param {unknown} payload
 */
export function handleSignal({ socket, io, roomManager, rateLimiter }, payload) {
  const { participantId } = socket.data;
  if (participantId === null) return;

  const parsed = validate('signal', payload);
  if (!parsed.ok) return rejectSignal(socket, echoedPeerId(payload), ERROR_CODES.INVALID_SIGNAL);

  const { to, data } = parsed.value;
  if (!rateLimiter.consume(socket.id, 'signal')) {
    return rejectSignal(socket, to, ERROR_CODES.RATE_LIMITED);
  }
  const target = to === participantId ? null : roomManager.getRoomOf(participantId).get(to);
  if (!target) return rejectSignal(socket, to, ERROR_CODES.PEER_NOT_FOUND);

  io.to(target.socketId).emit(SERVER_EVENTS.SIGNAL, { from: participantId, data });
}

function rejectSignal(socket, to, code) {
  socket.emit(SERVER_EVENTS.SIGNAL_ERROR, { to, code });
}

/** `to` из некорректного payload возвращается, только если это строка разумной длины. */
function echoedPeerId(payload) {
  const to = payload?.to;
  return typeof to === 'string' && to.length <= PEER_ID_MAX_LENGTH ? to : null;
}
