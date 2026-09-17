// Вход в комнату, выход и отключение сокета (TDD §6.3, §6.4, §7.1, §7.3, §7.6).
// Доступ к комнате по известному roomId не ограничивается и «владельца» у комнаты нет (FR-6, FR-32).
import {
  ERROR_CODES,
  MESSAGE_MAX_LENGTH,
  SERVER_EVENTS,
  isValidRoomId,
  validateName,
} from '@vcr/shared';
import { validate } from '../validatePayload.js';

/** @typedef {import('../registerHandlers.js').HandlerContext} HandlerContext */
/** @typedef {import('../registerHandlers.js').Reply} Reply */

/**
 * `room:join`: форма payload → rate limit → roomId и имя → один сокет — один участник →
 * атомарный вход → рассылка остальным → ack со снимком комнаты.
 * @param {HandlerContext} context
 * @param {unknown} payload
 * @param {Reply} reply
 */
export function handleJoin(context, payload, reply) {
  const { socket, roomManager, rateLimiter, logger, iceServers } = context;

  const parsed = validate('join', payload);
  if (!parsed.ok) return reply.error(parsed.code);
  if (!rateLimiter.consume(socket.id, 'join')) return reply.error(ERROR_CODES.RATE_LIMITED);

  const { roomId } = parsed.value;
  if (!isValidRoomId(roomId)) return reply.error(ERROR_CODES.INVALID_ROOM_ID);
  const name = validateName(parsed.value.name);
  if (!name.ok) return reply.error(ERROR_CODES.INVALID_NAME);
  if (socket.data.participantId !== null) return reply.error(ERROR_CODES.ALREADY_IN_ROOM);

  // Между RoomManager.join и socket.join нет await (TDD §4.2.2): до рассылки ни одно другое
  // событие не увидит участника без комнаты сокета. socket.data заполняется сразу, чтобы
  // disconnect освободил слот, даже если дальше что-то упадёт.
  const outcome = roomManager.join({ roomId, name: name.value, socketId: socket.id });
  if (!outcome.ok) {
    logger.info({ roomId, socketId: socket.id, code: outcome.code }, 'room join rejected');
    return reply.error(outcome.code);
  }
  const { room, participant } = outcome;
  socket.data.participantId = participant.id;
  socket.data.roomId = roomId;
  socket.join(roomId);

  // Снимок до системного сообщения: своё «присоединился» новичку не нужно (TDD §5.3).
  const snapshot = room.snapshot(participant.id);
  const self = roomManager.toDTO(participant);
  socket.to(roomId).emit(SERVER_EVENTS.PARTICIPANT_JOINED, { participant: self });
  const message = roomManager.addSystemMessage(roomId, 'joined', participant.name);
  socket.to(roomId).emit(SERVER_EVENTS.CHAT_MESSAGE, { message });

  logger.info({ roomId, participantId: participant.id, size: room.size }, 'participant joined');
  logger.debug(
    { roomId, participantId: participant.id, name: participant.name },
    'participant name',
  );

  reply.ok({
    self,
    participants: snapshot.participants,
    messages: snapshot.messages,
    iceServers,
    limits: { messageMaxLength: MESSAGE_MAX_LENGTH },
  });
}

/**
 * `room:leave`. Payload не нужен и не проверяется; ack необязателен, чтобы клиент мог выйти
 * без ожидания ответа при закрытии страницы (pagehide).
 * @param {HandlerContext} context
 * @param {unknown} payload
 * @param {Reply} reply
 */
export function handleLeave(context, payload, reply) {
  if (!leaveRoom(context, 'room:leave')) return reply.error(ERROR_CODES.NOT_IN_ROOM);
  reply.ok();
}

/**
 * `disconnect`: закрытие вкладки, обрыв сети или остановка сервера — это тоже выход (FR-28, FR-31).
 * Rate limit сбрасывается только здесь: после `room:leave` сокет может войти снова, и сброс
 * позволил бы обходить лимит `join` циклом вход-выход.
 * @param {HandlerContext} context
 * @param {string} reason  причина отключения от Socket.io
 */
export function handleDisconnect(context, reason) {
  try {
    leaveRoom(context, reason);
  } finally {
    context.rateLimiter.forget(context.socket.id);
  }
}

/**
 * Общий выход для `room:leave` и `disconnect`: остальные получают `participant:left` и системное
 * сообщение «покинул(а) комнату» — без формулировки «соединение потеряно» (FR-31). Последний
 * участник удаляет комнату вместе с историей (FR-9), и рассылать некому.
 * @param {HandlerContext} context
 * @param {string} reason  для лога
 * @returns {boolean}  `false`, если сокет не был в комнате
 */
function leaveRoom({ socket, io, roomManager, logger }, reason) {
  const { participantId, roomId } = socket.data;
  if (participantId === null) return false;

  socket.data.participantId = null;
  socket.data.roomId = null;
  socket.leave(roomId);
  const { participant, roomDeleted } = roomManager.leave(participantId);
  logger.info({ roomId, participantId, reason, roomDeleted }, 'participant left');
  if (roomDeleted) return true;

  io.to(roomId).emit(SERVER_EVENTS.PARTICIPANT_LEFT, { participantId });
  const message = roomManager.addSystemMessage(roomId, 'left', participant.name);
  io.to(roomId).emit(SERVER_EVENTS.CHAT_MESSAGE, { message });
  return true;
}
