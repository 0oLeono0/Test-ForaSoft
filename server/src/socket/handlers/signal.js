// Пересылка данных WebRTC-сигналинга между участниками одной комнаты (TDD §3.2, §6.3, §6.5, §10.1).
import { ERROR_CODES, SERVER_EVENTS } from '@vcr/shared';
import { PEER_ID_MAX_LENGTH, validate } from '../validatePayload.js';

/** @typedef {import('../registerHandlers.js').HandlerContext} HandlerContext */

/**
 * `signal`: ответа через ack нет, об ошибке отправитель узнаёт из `signal:error { to, code }`.
 * Сокет вне комнаты игнорируется. Далее: rate limit (RATE_LIMITED) → форма payload
 * (INVALID_SIGNAL) → получатель — другой участник той же комнаты (PEER_NOT_FOUND) → пересылка
 * только ему. `from` проставляет сервер: значение из payload отбрасывается при проверке формы.
 *
 * Лимит списывается до проверки формы (TDD §10.4): иначе поток мусорных payload ничем не
 * ограничен — на каждый уходит `signal:error`, и отбиваться от него дороже, чем его слать.
 * @param {HandlerContext} context
 * @param {unknown} payload
 */
export function handleSignal({ socket, io, roomManager, rateLimiter }, payload) {
  const { participantId } = socket.data;
  if (participantId === null) return;

  if (!rateLimiter.consume(socket.id, 'signal')) {
    return rejectSignal(socket, echoedPeerId(payload), ERROR_CODES.RATE_LIMITED);
  }
  const parsed = validate('signal', payload);
  if (!parsed.ok) return rejectSignal(socket, echoedPeerId(payload), ERROR_CODES.INVALID_SIGNAL);

  const { to, data } = parsed.value;
  // Комната на месте, пока `socket.data.participantId` заполнен, но на неожиданный порядок
  // событий отвечаем PEER_NOT_FOUND, а не исключением в обработчике.
  const room = roomManager.getRoomOf(participantId);
  const target = to === participantId ? null : (room?.get(to) ?? null);
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
