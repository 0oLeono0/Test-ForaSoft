import { CHAT_HISTORY_LIMIT } from '@vcr/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room, toParticipantDTO } from './Room.js';

function makeParticipant(id, overrides = {}) {
  return {
    id,
    socketId: `socket-${id}`,
    name: `Имя ${id}`,
    audio: false,
    video: false,
    joinedAt: 1789640000000,
    ...overrides,
  };
}

function makeMessage(n) {
  return { id: `m${n}`, type: 'user', ts: n, authorId: 'a', authorName: 'Алекс', text: `#${n}` };
}

function messageIds(room) {
  return room.snapshot().messages.map((message) => message.id);
}

function participantIds(room) {
  return room.snapshot().participants.map((participant) => participant.id);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Room: создание', () => {
  it('хранит id и время создания, начинает пустой', () => {
    vi.useFakeTimers({ now: 1789640000000 });
    const room = new Room('V1StGXR8_Z');

    expect(room.id).toBe('V1StGXR8_Z');
    expect(room.createdAt).toBe(1789640000000);
    expect(room.size).toBe(0);
    expect(room.snapshot()).toEqual({ participants: [], messages: [] });
  });

  it.each([0, -1, 1.5, NaN, '200'])('отклоняет historyLimit = %s', (historyLimit) => {
    expect(() => new Room('r', { historyLimit })).toThrow(RangeError);
  });
});

describe('Room: участники', () => {
  it('add/has/size/remove', () => {
    const room = new Room('r');
    const a = makeParticipant('a');

    room.add(a);
    expect(room.size).toBe(1);
    expect(room.has('a')).toBe(true);
    expect(room.has('b')).toBe(false);

    expect(room.remove('a')).toBe(a);
    expect(room.size).toBe(0);
    expect(room.has('a')).toBe(false);
  });

  it('remove неизвестного участника возвращает null и ничего не меняет', () => {
    const room = new Room('r');
    room.add(makeParticipant('a'));

    expect(room.remove('b')).toBeNull();
    expect(participantIds(room)).toEqual(['a']);
  });

  it('не добавляет участника с тем же id дважды', () => {
    const room = new Room('r');
    room.add(makeParticipant('a'));

    expect(() => room.add(makeParticipant('a', { name: 'Другое' }))).toThrow('уже в комнате');
    expect(room.size).toBe(1);
  });

  it('сохраняет порядок входа, в том числе после выхода из середины', () => {
    const room = new Room('r');
    for (const id of ['a', 'b', 'c']) room.add(makeParticipant(id));

    expect(participantIds(room)).toEqual(['a', 'b', 'c']);

    room.remove('b');
    room.add(makeParticipant('d'));
    expect(participantIds(room)).toEqual(['a', 'c', 'd']);
    expect([...room.participants.keys()]).toEqual(['a', 'c', 'd']);
  });
});

describe('Room: история', () => {
  it('хранит сообщения от старых к новым', () => {
    const room = new Room('r');
    for (let n = 1; n <= 3; n += 1) room.pushMessage(makeMessage(n));

    expect(messageIds(room)).toEqual(['m1', 'm2', 'm3']);
  });

  it(`хранит ровно ${CHAT_HISTORY_LIMIT} сообщений без вытеснения`, () => {
    const room = new Room('r');
    for (let n = 1; n <= CHAT_HISTORY_LIMIT; n += 1) room.pushMessage(makeMessage(n));

    const ids = messageIds(room);
    expect(ids).toHaveLength(CHAT_HISTORY_LIMIT);
    expect(ids[0]).toBe('m1');
    expect(ids.at(-1)).toBe(`m${CHAT_HISTORY_LIMIT}`);
  });

  it(`${CHAT_HISTORY_LIMIT + 1}-е сообщение вытесняет первое`, () => {
    const room = new Room('r');
    for (let n = 1; n <= CHAT_HISTORY_LIMIT + 1; n += 1) room.pushMessage(makeMessage(n));

    const ids = messageIds(room);
    expect(ids).toHaveLength(CHAT_HISTORY_LIMIT);
    expect(ids[0]).toBe('m2');
    expect(ids.at(-1)).toBe(`m${CHAT_HISTORY_LIMIT + 1}`);
  });

  it('после нескольких оборотов буфера остаются последние сообщения по порядку', () => {
    const room = new Room('r');
    const total = CHAT_HISTORY_LIMIT * 2 + 50;
    for (let n = 1; n <= total; n += 1) room.pushMessage(makeMessage(n));

    const expected = Array.from({ length: CHAT_HISTORY_LIMIT }, (_, i) => {
      return `m${total - CHAT_HISTORY_LIMIT + 1 + i}`;
    });
    expect(messageIds(room)).toEqual(expected);
  });

  it('учитывает historyLimit из параметров', () => {
    const room = new Room('r', { historyLimit: 3 });
    for (let n = 1; n <= 5; n += 1) room.pushMessage(makeMessage(n));

    expect(messageIds(room)).toEqual(['m3', 'm4', 'm5']);
  });

  it('хранит сообщения без изменений, включая системные', () => {
    const room = new Room('r');
    const system = { id: 's1', type: 'system', ts: 1, event: 'joined', subjectName: 'Мария' };
    const user = makeMessage(2);
    room.pushMessage(system);
    room.pushMessage(user);

    expect(room.snapshot().messages).toEqual([system, user]);
  });
});

describe('Room: snapshot', () => {
  it('отдаёт участников как ParticipantDTO без socketId и joinedAt', () => {
    const room = new Room('r');
    room.add(makeParticipant('a', { name: 'Мария', audio: true, video: true }));

    expect(room.snapshot().participants).toEqual([
      { id: 'a', name: 'Мария', audio: true, video: true },
    ]);
  });

  it('не включает исключённого участника и сохраняет порядок остальных', () => {
    const room = new Room('r');
    for (const id of ['a', 'b', 'c']) room.add(makeParticipant(id));

    const ids = room.snapshot('b').participants.map((participant) => participant.id);
    expect(ids).toEqual(['a', 'c']);
  });

  it('с неизвестным excludePid возвращает всех участников', () => {
    const room = new Room('r');
    for (const id of ['a', 'b']) room.add(makeParticipant(id));

    expect(room.snapshot('zzz').participants).toHaveLength(2);
  });

  it('не удаляет исключённого участника из комнаты', () => {
    const room = new Room('r');
    room.add(makeParticipant('a'));

    room.snapshot('a');
    expect(room.has('a')).toBe(true);
  });

  it('изменение снимка не затрагивает комнату', () => {
    const room = new Room('r');
    room.add(makeParticipant('a'));
    room.pushMessage(makeMessage(1));

    const snapshot = room.snapshot();
    snapshot.participants[0].name = 'Подмена';
    snapshot.participants.push({ id: 'x', name: 'x', audio: false, video: false });
    snapshot.messages.length = 0;

    expect(room.snapshot()).toEqual({
      participants: [{ id: 'a', name: 'Имя a', audio: false, video: false }],
      messages: [makeMessage(1)],
    });
  });
});

describe('toParticipantDTO', () => {
  it('оставляет только id, name, audio и video', () => {
    const dto = toParticipantDTO(makeParticipant('a', { audio: true }));

    expect(dto).toEqual({ id: 'a', name: 'Имя a', audio: true, video: false });
    expect(Object.keys(dto).sort()).toEqual(['audio', 'id', 'name', 'video']);
  });
});
