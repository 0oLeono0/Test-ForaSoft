import { describe, expect, it } from 'vitest';
import { REDACTED, createLogger } from './logger.js';

/** Логгер, записи которого собираются в массив разобранных JSON-объектов. */
function capture(options) {
  const records = [];
  const logger = createLogger(options, { write: (line) => records.push(JSON.parse(line)) });
  return { logger, records };
}

/** Всё, что не должно попасть в лог ни на каком уровне: текст чата, SDP и ICE-кандидаты. */
function sensitivePayload() {
  return {
    roomId: 'V1StGXR8_Z',
    participantId: 'b7c1',
    text: 'секретный текст',
    message: { id: 'm1', type: 'user', authorName: 'Мария', text: 'привет' },
    signal: { to: '4f2a', data: { type: 'offer', sdp: 'v=0\r\no=- 4611 2 IN IP4 192.168.1.5' } },
    ice: { data: { type: 'candidate', candidate: { candidate: 'candidate:1 1 udp 192.168.1.5' } } },
    messages: [{ type: 'user', text: 'из истории' }],
  };
}

describe('createLogger', () => {
  it('пишет JSON-записи с уровнем, сообщением и полями', () => {
    const { logger, records } = capture({ level: 'info' });

    logger.info({ roomId: 'V1StGXR8_Z', participantId: 'b7c1' }, 'room joined');

    expect(records).toEqual([
      expect.objectContaining({
        level: 30,
        msg: 'room joined',
        roomId: 'V1StGXR8_Z',
        participantId: 'b7c1',
      }),
    ]);
  });

  it('по умолчанию уровень info: debug не пишется', () => {
    const records = [];
    const logger = createLogger(undefined, { write: (line) => records.push(JSON.parse(line)) });

    logger.debug('скрыто');
    logger.info('видно');

    expect(logger.level).toBe('info');
    expect(records.map((record) => record.msg)).toEqual(['видно']);
  });

  it('silent не пишет ничего', () => {
    const { logger, records } = capture({ level: 'silent' });

    logger.fatal(sensitivePayload(), 'fatal');

    expect(records).toEqual([]);
  });

  it('ошибки сериализуются с сообщением и стеком', () => {
    const { logger, records } = capture({ level: 'info' });

    logger.error({ err: new Error('boom'), event: 'room:join' }, 'handler failed');

    expect(records[0].err).toMatchObject({ type: 'Error', message: 'boom' });
    expect(records[0].err.stack).toContain('boom');
    expect(records[0].event).toBe('room:join');
  });
});

describe('createLogger: redact', () => {
  it.each(['info', 'debug', 'trace'])(
    '%s: текст сообщений, SDP и кандидаты скрыты на любой глубине до трёх уровней',
    (level) => {
      const { logger, records } = capture({ level });

      logger[level](sensitivePayload(), 'payload');

      const [record] = records;
      expect(record.text).toBe(REDACTED);
      expect(record.message.text).toBe(REDACTED);
      expect(record.signal.data.sdp).toBe(REDACTED);
      expect(record.ice.data.candidate).toBe(REDACTED);
      expect(record.messages[0].text).toBe(REDACTED);
      expect(JSON.stringify(record)).not.toMatch(/секретный|привет|из истории|192\.168/);
      // Поля, нужные для диагностики, остаются.
      expect(record).toMatchObject({ roomId: 'V1StGXR8_Z', participantId: 'b7c1' });
      expect(record.signal).toMatchObject({ to: '4f2a', data: { type: 'offer' } });
    },
  );

  it.each(['info', 'warn', 'error', 'fatal'])('%s: имена участников скрыты', (level) => {
    const { logger, records } = capture({ level });

    logger[level](
      {
        name: 'Алекс',
        participant: { id: 'b7c1', name: 'Алекс' },
        message: { type: 'system', event: 'joined', subjectName: 'Мария' },
        payload: { message: { authorName: 'Пётр' } },
      },
      'names',
    );

    const [record] = records;
    expect(record.name).toBe(REDACTED);
    expect(record.participant).toEqual({ id: 'b7c1', name: REDACTED });
    expect(record.message).toEqual({ type: 'system', event: 'joined', subjectName: REDACTED });
    expect(record.payload.message.authorName).toBe(REDACTED);
  });

  it.each(['debug', 'trace'])('%s: имена участников видны', (level) => {
    const { logger, records } = capture({ level });

    logger.debug(
      { participant: { id: 'b7c1', name: 'Алекс' }, message: { subjectName: 'Мария' } },
      'names',
    );

    expect(records[0].participant.name).toBe('Алекс');
    expect(records[0].message.subjectName).toBe('Мария');
  });

  it('не меняет переданный объект', () => {
    const { logger } = capture({ level: 'info' });
    const payload = sensitivePayload();
    const copy = structuredClone(payload);

    logger.info(payload, 'payload');

    expect(payload).toEqual(copy);
  });
});
