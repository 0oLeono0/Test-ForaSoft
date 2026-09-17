import { CLIENT_EVENTS, SERVER_EVENTS } from '@vcr/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestbed } from '../../../test/socketTestbed.js';

const { MEDIA_STATE, ROOM_LEAVE } = CLIENT_EVENTS;
const { PARTICIPANT_MEDIA } = SERVER_EVENTS;

/** Комната из Марии и Алекса и отдельная комната Петра. */
function roomWithTwo() {
  const testbed = createTestbed();
  const maria = testbed.joinAs('Мария');
  const alex = testbed.joinAs('Алекс');
  const petr = testbed.joinAs('Пётр', 'other-room');
  for (const member of [maria, alex, petr]) member.socket.clearReceived();
  return { ...testbed, maria, alex, petr };
}

/** Состояние участника, как его видит вошедший позже. */
function stateSeenByNewcomer({ joinAs }, participantId) {
  return joinAs('Иван').ack.participants.find(({ id }) => id === participantId);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('media:state', () => {
  it('participant:media получают остальные участники комнаты, но не отправитель и не другие комнаты', () => {
    const { maria, alex, petr } = roomWithTwo();

    alex.socket.send(MEDIA_STATE, { audio: false, video: true });

    expect(maria.socket.received).toEqual([
      { event: PARTICIPANT_MEDIA, payload: { participantId: alex.id, audio: false, video: true } },
    ]);
    expect(alex.socket.received).toEqual([]);
    expect(petr.socket.received).toEqual([]);
  });

  it('состояние запоминается: вошедший позже видит актуальные индикаторы в ack (I-10)', () => {
    const testbed = roomWithTwo();
    testbed.alex.socket.send(MEDIA_STATE, { audio: true, video: true });
    testbed.alex.socket.send(MEDIA_STATE, { audio: false, video: true });

    expect(stateSeenByNewcomer(testbed, testbed.alex.id)).toEqual({
      id: testbed.alex.id,
      name: 'Алекс',
      audio: false,
      video: true,
    });
  });

  it('participantId и лишние поля из payload игнорируются', () => {
    const testbed = roomWithTwo();
    const { maria, alex } = testbed;

    alex.socket.send(MEDIA_STATE, {
      audio: true,
      video: false,
      participantId: maria.id,
      name: 'X',
    });

    expect(maria.socket.eventsOf(PARTICIPANT_MEDIA)).toEqual([
      { participantId: alex.id, audio: true, video: false },
    ]);
    expect(stateSeenByNewcomer(testbed, maria.id)).toMatchObject({ audio: false, video: false });
  });

  it('ack не вызывается: у события нет ответа', () => {
    const { alex } = roomWithTwo();
    const ack = vi.fn();

    alex.socket.send(MEDIA_STATE, { audio: true, video: true }, ack);

    expect(ack).not.toHaveBeenCalled();
  });

  it('не в комнате — молча игнорируется', () => {
    const { io, maria, logger, roomManager } = roomWithTwo();
    const setMediaState = vi.spyOn(roomManager, 'setMediaState');
    const socket = io.connect();

    expect(() => socket.send(MEDIA_STATE, { audio: true, video: true })).not.toThrow();

    expect(setMediaState).not.toHaveBeenCalled();
    expect(maria.socket.received).toEqual([]);
    expect(socket.received).toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('после выхода — молча игнорируется', () => {
    const { maria, alex } = roomWithTwo();
    alex.socket.request(ROOM_LEAVE);
    maria.socket.clearReceived();

    alex.socket.send(MEDIA_STATE, { audio: true, video: true });

    expect(maria.socket.received).toEqual([]);
  });

  it.each([
    ['без payload', []],
    ['null', [null]],
    ['строка', ['on']],
    ['audio не boolean', [{ audio: 'true', video: true }]],
    ['нет video', [{ audio: true }]],
    ['числа', [{ audio: 1, video: 0 }]],
  ])('%s — молча игнорируется, состояние не меняется', (_, args) => {
    const testbed = roomWithTwo();
    const { maria, alex, logger } = testbed;

    alex.socket.send(MEDIA_STATE, ...args);

    expect(maria.socket.received).toEqual([]);
    expect(stateSeenByNewcomer(testbed, alex.id)).toMatchObject({ audio: false, video: false });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('больше 20 событий за 10 с — лишние молча отбрасываются и состояние не меняют', () => {
    vi.useFakeTimers({ now: 1789640000000 });
    const testbed = roomWithTwo();
    const { maria, alex } = testbed;
    for (let i = 0; i < 20; i += 1) {
      alex.socket.send(MEDIA_STATE, { audio: i % 2 === 0, video: false });
    }

    alex.socket.send(MEDIA_STATE, { audio: true, video: true });

    expect(maria.socket.eventsOf(PARTICIPANT_MEDIA)).toHaveLength(20);
    expect(maria.socket.eventsOf(PARTICIPANT_MEDIA).at(-1)).toMatchObject({ audio: false });

    vi.advanceTimersByTime(500);
    alex.socket.send(MEDIA_STATE, { audio: true, video: true });
    expect(maria.socket.eventsOf(PARTICIPANT_MEDIA)).toHaveLength(21);
    expect(stateSeenByNewcomer(testbed, alex.id)).toMatchObject({ audio: true, video: true });
  });

  it('payload неверной формы не расходует лимит', () => {
    const { maria, alex } = roomWithTwo();
    for (let i = 0; i < 30; i += 1) alex.socket.send(MEDIA_STATE, 'junk');

    alex.socket.send(MEDIA_STATE, { audio: true, video: true });

    expect(maria.socket.eventsOf(PARTICIPANT_MEDIA)).toHaveLength(1);
  });
});
