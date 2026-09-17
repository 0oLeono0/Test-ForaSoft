// Обработчики событий Socket.io для каждого подключения (TDD §4.2.1, §6.2, §6.3): начальное
// socket.data, таблица «событие → обработчик» и обёртка, которая превращает исключение в ack
// INTERNAL_ERROR и запись в лог. Без обёртки исключение в обработчике Socket.io роняет процесс.
import { CLIENT_EVENTS, ERROR_CODES, ERROR_MESSAGES } from '@vcr/shared';
import { handleChatSend } from './handlers/chat.js';
import { handleMediaState } from './handlers/media.js';
import { handleDisconnect, handleJoin, handleLeave } from './handlers/room.js';

/**
 * @typedef {Object} HandlerDeps
 * @property {import('../rooms/RoomManager.js').RoomManager} roomManager
 * @property {import('./rateLimiter.js').RateLimiter} rateLimiter
 * @property {import('pino').Logger} logger
 * @property {readonly RTCIceServer[]} iceServers  // отдаются клиенту в ack room:join
 */

/**
 * То, что получает обработчик: зависимости, сервер и сокет клиента.
 * @typedef {HandlerDeps & { io: import('socket.io').Server, socket: import('socket.io').Socket }} HandlerContext
 */

/**
 * Ответ в формате ack (TDD §6.2): `{ ok: true, ...data }` или `{ ok: false, error }`. Если клиент
 * не передал ack, вызовы ничего не делают.
 * @typedef {Object} Reply
 * @property {(data?: object) => void} ok
 * @property {(code: import('@vcr/shared').ErrorCode) => void} error
 */

/** @typedef {(context: HandlerContext, payload: unknown, reply: Reply) => void} EventHandler */

/** @type {Readonly<Record<string, EventHandler>>} */
const EVENT_HANDLERS = Object.freeze({
  [CLIENT_EVENTS.ROOM_JOIN]: handleJoin,
  [CLIENT_EVENTS.ROOM_LEAVE]: handleLeave,
  [CLIENT_EVENTS.CHAT_SEND]: handleChatSend,
  [CLIENT_EVENTS.MEDIA_STATE]: handleMediaState,
});

/**
 * @param {import('socket.io').Server} io
 * @param {HandlerDeps} deps
 */
export function registerHandlers(io, deps) {
  io.on('connection', (socket) => {
    socket.data = { participantId: null, roomId: null };
    const context = { ...deps, io, socket };

    for (const [event, handler] of Object.entries(EVENT_HANDLERS)) {
      socket.on(event, (...args) => {
        // Ack клиент передаёт последним аргументом; payload — первый аргумент до него.
        const reply = createReply(typeof args.at(-1) === 'function' ? args.pop() : null);
        runSafely(context, event, reply, () => handler(context, args[0], reply));
      });
    }
    socket.on('disconnect', (reason) => {
      runSafely(context, 'disconnect', null, () => handleDisconnect(context, reason));
    });
  });
}

/** @returns {Reply} */
function createReply(ack) {
  // Повторные вызовы ack Socket.io не доставляет: клиент получает только первый ответ.
  const send = (response) => ack?.(response);
  return {
    ok: (data = {}) => send({ ok: true, ...data }),
    error: (code) => send({ ok: false, error: { code, message: ERROR_MESSAGES[code] } }),
  };
}

/**
 * @param {HandlerContext} context
 * @param {string} event
 * @param {Reply | null} reply  куда сообщить об INTERNAL_ERROR; `null` для событий без ответа
 * @param {() => void} run
 */
function runSafely({ socket, logger }, event, reply, run) {
  try {
    run();
  } catch (error) {
    const { participantId, roomId } = socket.data;
    logger.error(
      { err: error, event, socketId: socket.id, participantId, roomId },
      'socket handler failed',
    );
    reply?.error(ERROR_CODES.INTERNAL_ERROR);
  }
}
