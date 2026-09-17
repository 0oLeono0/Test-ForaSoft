// Структурированные JSON-логи pino (TDD §10.5). В логи идут roomId, participantId, коды событий и
// ошибок. Текст сообщений, SDP и ICE-кандидаты (в них IP-адреса) скрываются на любом уровне,
// имена участников — на любом уровне, кроме debug и trace.
import pino from 'pino';

/** Замена скрытого значения в записи лога. */
export const REDACTED = '[REDACTED]';

/** Поля, которые не пишутся никогда. */
const CONTENT_FIELDS = ['text', 'sdp', 'candidate'];

/** Поля с именами участников: `ParticipantDTO.name`, `ChatMessage.authorName` и `subjectName`. */
const NAME_FIELDS = ['name', 'authorName', 'subjectName'];

/** Глубина вложенности, до которой ищутся поля: `text`, `message.text`, `payload.data.sdp`. */
const REDACT_DEPTH = 3;

function redactPaths(fields) {
  return fields.flatMap((field) =>
    Array.from({ length: REDACT_DEPTH }, (_, depth) =>
      [...Array(depth).fill('*'), field].join('.'),
    ),
  );
}

/**
 * @param {{ level?: string }} [options]  уровень из `config.logLevel`
 * @param {import('pino').DestinationStream} [destination]  по умолчанию stdout
 * @returns {import('pino').Logger}
 */
export function createLogger({ level = 'info' } = {}, destination = undefined) {
  // У `silent` нет числового значения: имена скрыты, как и на остальных уровнях выше debug.
  const namesVisible = pino.levels.values[level] <= pino.levels.values.debug;
  const fields = namesVisible ? CONTENT_FIELDS : [...CONTENT_FIELDS, ...NAME_FIELDS];
  return pino({ level, redact: { paths: redactPaths(fields), censor: REDACTED } }, destination);
}
