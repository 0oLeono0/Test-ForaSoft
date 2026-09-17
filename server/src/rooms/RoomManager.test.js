import { ERROR_CODES, MAX_PARTICIPANTS } from '@vcr/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room } from './Room.js';
import { RoomManager } from './RoomManager.js';

const ROOM_ID = 'V1StGXR8_Z';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PARTICIPANT_FIELDS = ['audio', 'id', 'joinedAt', 'name', 'socketId', 'video'];

/** Входит в комнату и возвращает участника; падает, если вход не удался. */
function joinOk(manager, name, roomId = ROOM_ID) {
  const outcome = manager.join({ roomId, name, socketId: `socket-${name}` });
  expect(outcome.ok, `вход ${name} в ${roomId}`).toBe(true);
  return outcome.participant;
}

function fillRoom(manager, roomId = ROOM_ID) {
  return Array.from({ length: MAX_PARTICIPANTS }, (_, i) => joinOk(manager, `u${i + 1}`, roomId));
}

function participantNames(manager, roomId = ROOM_ID) {
  return manager.rooms
    .get(roomId)
    .snapshot()
    .participants.map((participant) => participant.name);
}

/** `byParticipant` указывает ровно на тех, кто сейчас сидит в комнатах. */
function expectIndexConsistent(manager) {
  const seated = [...manager.rooms.values()].flatMap((room) =>
    [...room.participants.keys()].map((participantId) => [participantId, room.id]),
  );
  expect(Object.fromEntries(manager.byParticipant)).toEqual(Object.fromEntries(seated));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('RoomManager.join', () => {
  it('первый вход создаёт комнату, участник в ней первый', () => {
    vi.useFakeTimers({ now: 1789640000000 });
    const manager = new RoomManager();
    expect(manager.rooms.has(ROOM_ID)).toBe(false);

    const outcome = manager.join({ roomId: ROOM_ID, name: 'Мария', socketId: 'sock-1' });

    expect(outcome).toEqual({ ok: true, room: expect.any(Room), participant: expect.any(Object) });
    expect(outcome.participant).toEqual({
      id: expect.stringMatching(UUID),
      socketId: 'sock-1',
      name: 'Мария',
      audio: false,
      video: false,
      joinedAt: 1789640000000,
    });
    expect(manager.rooms.get(ROOM_ID)).toBe(outcome.room);
    expect(outcome.room.id).toBe(ROOM_ID);
    expect(outcome.room.has(outcome.participant.id)).toBe(true);
    expect(manager.byParticipant.get(outcome.participant.id)).toBe(ROOM_ID);
  });

  it('синхронный: возвращает результат, а не Promise', () => {
    const manager = new RoomManager();

    const outcome = manager.join({ roomId: ROOM_ID, name: 'Мария', socketId: 'sock-1' });

    expect(outcome).not.toBeInstanceOf(Promise);
    expect(outcome.ok).toBe(true);
  });

  it('следующие участники попадают в ту же комнату в порядке входа', () => {
    const manager = new RoomManager();
    const first = manager.join({ roomId: ROOM_ID, name: 'Мария', socketId: 's1' });
    const second = manager.join({ roomId: ROOM_ID, name: 'Алекс', socketId: 's2' });

    expect(second.room).toBe(first.room);
    expect(manager.rooms.size).toBe(1);
    expect(participantNames(manager)).toEqual(['Мария', 'Алекс']);
  });

  it(`${MAX_PARTICIPANTS} входа успешны, ${MAX_PARTICIPANTS + 1}-й получает ROOM_FULL`, () => {
    const manager = new RoomManager();
    fillRoom(manager);

    const outcome = manager.join({ roomId: ROOM_ID, name: 'Пётр', socketId: 's5' });

    expect(outcome).toEqual({ ok: false, code: ERROR_CODES.ROOM_FULL });
    expect(manager.rooms.get(ROOM_ID).size).toBe(MAX_PARTICIPANTS);
    expect(manager.byParticipant.size).toBe(MAX_PARTICIPANTS);
    expect(participantNames(manager)).not.toContain('Пётр');
    expectIndexConsistent(manager);
  });

  it('повторные попытки в заполненную комнату не меняют её', () => {
    const manager = new RoomManager();
    fillRoom(manager);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(manager.join({ roomId: ROOM_ID, name: 'Пётр', socketId: 's5' }).ok).toBe(false);
    }
    expect(participantNames(manager)).toEqual(['u1', 'u2', 'u3', 'u4']);
  });

  it('после выхода одного участника вход снова успешен', () => {
    const manager = new RoomManager();
    const [, second] = fillRoom(manager);
    expect(manager.join({ roomId: ROOM_ID, name: 'Пётр', socketId: 's5' }).ok).toBe(false);

    manager.leave(second.id);
    const outcome = manager.join({ roomId: ROOM_ID, name: 'Пётр', socketId: 's5' });

    expect(outcome.ok).toBe(true);
    expect(participantNames(manager)).toEqual(['u1', 'u3', 'u4', 'Пётр']);
    expect(manager.join({ roomId: ROOM_ID, name: 'Ещё', socketId: 's6' }).ok).toBe(false);
    expectIndexConsistent(manager);
  });

  it('лимит считается для каждой комнаты отдельно', () => {
    const manager = new RoomManager();
    fillRoom(manager);

    const outcome = manager.join({ roomId: 'other-room', name: 'Пётр', socketId: 's5' });

    expect(outcome.ok).toBe(true);
    expect(outcome.room).not.toBe(manager.rooms.get(ROOM_ID));
    expect(manager.rooms.size).toBe(2);
    expectIndexConsistent(manager);
  });

  it('одинаковые имена в одной комнате — разные участники с разными id (FR-30)', () => {
    const manager = new RoomManager();
    const first = joinOk(manager, 'Алекс');
    const second = joinOk(manager, 'Алекс');

    expect(first.id).not.toBe(second.id);
    expect(manager.rooms.get(ROOM_ID).size).toBe(2);
    expect(participantNames(manager)).toEqual(['Алекс', 'Алекс']);
  });

  it('у всех участников одинаковые права: у первого нет флагов «создатель» (FR-32)', () => {
    const manager = new RoomManager();
    const [creator, ...others] = fillRoom(manager);

    for (const participant of [creator, ...others]) {
      expect(Object.keys(participant).sort()).toEqual(PARTICIPANT_FIELDS);
    }
  });

  it('передаёт historyLimit в создаваемые комнаты', () => {
    const manager = new RoomManager({ historyLimit: 2 });
    const { room } = manager.join({ roomId: ROOM_ID, name: 'Мария', socketId: 's1' });

    for (let n = 1; n <= 3; n += 1) room.pushMessage({ id: `m${n}`, type: 'user', ts: n });

    expect(room.snapshot().messages.map((message) => message.id)).toEqual(['m2', 'm3']);
  });
});

describe('RoomManager.leave', () => {
  it('удаляет участника, комната остаётся, пока в ней кто-то есть', () => {
    const manager = new RoomManager();
    const maria = joinOk(manager, 'Мария');
    const alex = joinOk(manager, 'Алекс');
    const room = manager.rooms.get(ROOM_ID);

    const outcome = manager.leave(maria.id);

    expect(outcome).toEqual({ room, participant: maria, roomDeleted: false });
    expect(outcome.room).toBe(room);
    expect(outcome.participant).toBe(maria);
    expect(manager.rooms.get(ROOM_ID)).toBe(room);
    expect(participantNames(manager)).toEqual(['Алекс']);
    expect(manager.byParticipant.has(maria.id)).toBe(false);
    expect(manager.byParticipant.get(alex.id)).toBe(ROOM_ID);
  });

  it('выход последнего участника удаляет комнату (FR-9)', () => {
    const manager = new RoomManager();
    const maria = joinOk(manager, 'Мария');
    const room = manager.rooms.get(ROOM_ID);

    const outcome = manager.leave(maria.id);

    expect(outcome).toEqual({ room, participant: maria, roomDeleted: true });
    expect(manager.rooms.has(ROOM_ID)).toBe(false);
    expect(manager.rooms.size).toBe(0);
    expect(manager.byParticipant.size).toBe(0);
  });

  it('повторный вход по тому же id после удаления создаёт новую комнату с пустой историей', () => {
    const manager = new RoomManager();
    const maria = joinOk(manager, 'Мария');
    const oldRoom = manager.rooms.get(ROOM_ID);
    oldRoom.pushMessage({ id: 'm1', type: 'user', ts: 1, text: 'Привет' });

    manager.leave(maria.id);
    const outcome = manager.join({ roomId: ROOM_ID, name: 'Алекс', socketId: 's2' });

    expect(outcome.ok).toBe(true);
    expect(outcome.room).not.toBe(oldRoom);
    expect(outcome.room.snapshot()).toEqual({
      participants: [{ id: outcome.participant.id, name: 'Алекс', audio: false, video: false }],
      messages: [],
    });
  });

  it('идемпотентный: второй leave того же участника возвращает null и ничего не меняет', () => {
    const manager = new RoomManager();
    const maria = joinOk(manager, 'Мария');
    joinOk(manager, 'Алекс');

    expect(manager.leave(maria.id)).not.toBeNull();
    expect(manager.leave(maria.id)).toBeNull();

    expect(participantNames(manager)).toEqual(['Алекс']);
    expectIndexConsistent(manager);
  });

  it('двойной leave последнего участника не ломает повторное создание комнаты', () => {
    const manager = new RoomManager();
    const maria = joinOk(manager, 'Мария');

    expect(manager.leave(maria.id).roomDeleted).toBe(true);
    expect(manager.leave(maria.id)).toBeNull();

    expect(manager.rooms.size).toBe(0);
    expect(manager.join({ roomId: ROOM_ID, name: 'Алекс', socketId: 's2' }).ok).toBe(true);
  });

  it('неизвестный participantId возвращает null', () => {
    const manager = new RoomManager();
    joinOk(manager, 'Мария');

    expect(manager.leave('00000000-0000-4000-8000-000000000000')).toBeNull();
    expect(participantNames(manager)).toEqual(['Мария']);
  });

  it('выход из одной комнаты не затрагивает другую', () => {
    const manager = new RoomManager();
    const maria = joinOk(manager, 'Мария', 'room-a');
    joinOk(manager, 'Алекс', 'room-b');

    expect(manager.leave(maria.id).roomDeleted).toBe(true);

    expect(manager.rooms.has('room-a')).toBe(false);
    expect(participantNames(manager, 'room-b')).toEqual(['Алекс']);
    expectIndexConsistent(manager);
  });
});

function historyOf(manager, roomId = ROOM_ID) {
  return manager.rooms.get(roomId).snapshot().messages;
}

describe('RoomManager.getRoomOf', () => {
  it('возвращает комнату участника', () => {
    const manager = new RoomManager();
    const maria = joinOk(manager, 'Мария', 'room-a');
    const alex = joinOk(manager, 'Алекс', 'room-b');

    expect(manager.getRoomOf(maria.id)).toBe(manager.rooms.get('room-a'));
    expect(manager.getRoomOf(alex.id)).toBe(manager.rooms.get('room-b'));
  });

  it('возвращает null для неизвестного и вышедшего участника', () => {
    const manager = new RoomManager();
    const maria = joinOk(manager, 'Мария');
    joinOk(manager, 'Алекс');
    manager.leave(maria.id);

    expect(manager.getRoomOf(maria.id)).toBeNull();
    expect(manager.getRoomOf('unknown')).toBeNull();
  });
});

describe('RoomManager.addChatMessage', () => {
  it('создаёт пользовательское сообщение со временем сервера и именем автора', () => {
    vi.useFakeTimers({ now: 1789640012000 });
    const manager = new RoomManager();
    const maria = joinOk(manager, 'Мария');

    const message = manager.addChatMessage(maria.id, 'Всем привет <b>!</b>');

    expect(message).toEqual({
      id: expect.stringMatching(UUID),
      type: 'user',
      ts: 1789640012000,
      authorId: maria.id,
      authorName: 'Мария',
      text: 'Всем привет <b>!</b>',
    });
  });

  it('сохраняет сообщение в историю комнаты автора и не трогает другие комнаты', () => {
    const manager = new RoomManager();
    const maria = joinOk(manager, 'Мария', 'room-a');
    joinOk(manager, 'Алекс', 'room-b');

    const message = manager.addChatMessage(maria.id, 'Привет');

    expect(historyOf(manager, 'room-a')).toEqual([message]);
    expect(historyOf(manager, 'room-b')).toEqual([]);
  });

  it('вошедший позже получает историю в порядке отправки (FR-23)', () => {
    const manager = new RoomManager();
    const maria = joinOk(manager, 'Мария');
    const first = manager.addChatMessage(maria.id, 'Раз');
    const second = manager.addChatMessage(maria.id, 'Два');

    const { room, participant } = manager.join({ roomId: ROOM_ID, name: 'Алекс', socketId: 's2' });

    expect(room.snapshot(participant.id).messages).toEqual([first, second]);
  });

  it('у каждого сообщения свой id', () => {
    const manager = new RoomManager();
    const maria = joinOk(manager, 'Мария');

    const first = manager.addChatMessage(maria.id, 'Привет');
    const second = manager.addChatMessage(maria.id, 'Привет');

    expect(first.id).not.toBe(second.id);
  });

  it('имя автора — снимок на момент отправки', () => {
    const manager = new RoomManager();
    const maria = joinOk(manager, 'Мария');
    const message = manager.addChatMessage(maria.id, 'Привет');

    maria.name = 'Мария Иванова';

    expect(message.authorName).toBe('Мария');
    expect(historyOf(manager)[0].authorName).toBe('Мария');
  });

  it('возвращает null и не пишет в историю, если автор не в комнате', () => {
    const manager = new RoomManager();
    joinOk(manager, 'Мария');
    const alex = joinOk(manager, 'Алекс');
    manager.leave(alex.id);

    expect(manager.addChatMessage(alex.id, 'Привет')).toBeNull();
    expect(manager.addChatMessage('unknown', 'Привет')).toBeNull();
    expect(historyOf(manager)).toEqual([]);
  });
});

describe('RoomManager.addSystemMessage', () => {
  it('сохраняет системное сообщение в историю комнаты (TDD §5.3)', () => {
    vi.useFakeTimers({ now: 1789640030000 });
    const manager = new RoomManager();
    joinOk(manager, 'Мария');

    const message = manager.addSystemMessage(ROOM_ID, 'joined', 'Мария');

    expect(message).toEqual({
      id: expect.stringMatching(UUID),
      type: 'system',
      ts: 1789640030000,
      event: 'joined',
      subjectName: 'Мария',
    });
    expect(historyOf(manager)).toEqual([message]);
  });

  it('системные и пользовательские сообщения хранятся в одной ленте по порядку', () => {
    const manager = new RoomManager();
    joinOk(manager, 'Мария');
    manager.addSystemMessage(ROOM_ID, 'joined', 'Мария');
    const alex = joinOk(manager, 'Алекс');
    manager.addSystemMessage(ROOM_ID, 'joined', 'Алекс');
    manager.addChatMessage(alex.id, 'Привет');
    manager.leave(alex.id);
    manager.addSystemMessage(ROOM_ID, 'left', 'Алекс');

    const feed = historyOf(manager).map((m) => m.text ?? `${m.event}:${m.subjectName}`);
    expect(feed).toEqual(['joined:Мария', 'joined:Алекс', 'Привет', 'left:Алекс']);
  });

  it('возвращает null и не создаёт комнату заново, если её уже нет', () => {
    const manager = new RoomManager();
    const maria = joinOk(manager, 'Мария');
    manager.leave(maria.id);

    expect(manager.addSystemMessage(ROOM_ID, 'left', 'Мария')).toBeNull();
    expect(manager.rooms.has(ROOM_ID)).toBe(false);
  });
});

describe('RoomManager.setMediaState', () => {
  it('обновляет индикаторы участника и возвращает его', () => {
    const manager = new RoomManager();
    const maria = joinOk(manager, 'Мария');

    expect(manager.setMediaState(maria.id, { audio: true, video: false })).toBe(maria);
    expect(maria).toMatchObject({ audio: true, video: false });

    manager.setMediaState(maria.id, { audio: false, video: true });
    expect(maria).toMatchObject({ audio: false, video: true });
  });

  it('вошедший позже видит актуальное состояние в снимке', () => {
    const manager = new RoomManager();
    const maria = joinOk(manager, 'Мария');
    manager.setMediaState(maria.id, { audio: true, video: true });

    const { room, participant } = manager.join({ roomId: ROOM_ID, name: 'Алекс', socketId: 's2' });

    expect(room.snapshot(participant.id).participants).toEqual([
      { id: maria.id, name: 'Мария', audio: true, video: true },
    ]);
  });

  it('берёт из состояния только audio и video', () => {
    const manager = new RoomManager();
    const maria = joinOk(manager, 'Мария');

    manager.setMediaState(maria.id, { audio: true, video: true, id: 'x', name: 'Подмена' });

    expect(maria).toMatchObject({ name: 'Мария', audio: true, video: true });
    expect(manager.byParticipant.get(maria.id)).toBe(ROOM_ID);
    expect(Object.keys(maria).sort()).toEqual(PARTICIPANT_FIELDS);
  });

  it('возвращает null и ничего не меняет, если участник не в комнате', () => {
    const manager = new RoomManager();
    joinOk(manager, 'Мария');
    const alex = joinOk(manager, 'Алекс');
    manager.leave(alex.id);

    expect(manager.setMediaState(alex.id, { audio: true, video: true })).toBeNull();
    expect(manager.setMediaState('unknown', { audio: true, video: true })).toBeNull();
    expect(alex).toMatchObject({ audio: false, video: false });
  });
});

describe('RoomManager.stats', () => {
  it('считает комнаты и участников во всех комнатах', () => {
    const manager = new RoomManager();
    expect(manager.stats()).toEqual({ rooms: 0, participants: 0 });

    const maria = joinOk(manager, 'Мария', 'room-a');
    joinOk(manager, 'Алекс', 'room-a');
    joinOk(manager, 'Пётр', 'room-b');
    expect(manager.stats()).toEqual({ rooms: 2, participants: 3 });

    manager.leave(maria.id);
    expect(manager.stats()).toEqual({ rooms: 2, participants: 2 });
  });

  it('отказ ROOM_FULL не меняет счётчики', () => {
    const manager = new RoomManager();
    fillRoom(manager);

    manager.join({ roomId: ROOM_ID, name: 'Пётр', socketId: 's5' });

    expect(manager.stats()).toEqual({ rooms: 1, participants: MAX_PARTICIPANTS });
  });

  it('когда все вышли, комнат не остаётся', () => {
    const manager = new RoomManager();
    const participants = [...fillRoom(manager), joinOk(manager, 'Пётр', 'room-b')];

    for (const participant of participants) manager.leave(participant.id);

    expect(manager.stats()).toEqual({ rooms: 0, participants: 0 });
  });
});

describe('RoomManager.toDTO', () => {
  it('отдаёт id, name, audio и video без socketId и joinedAt', () => {
    const manager = new RoomManager();
    const maria = joinOk(manager, 'Мария');
    manager.setMediaState(maria.id, { audio: true, video: false });

    const dto = manager.toDTO(maria);

    expect(dto).toEqual({ id: maria.id, name: 'Мария', audio: true, video: false });
    expect(dto).not.toHaveProperty('socketId');
    expect(dto).not.toHaveProperty('joinedAt');
  });

  it('возвращает новый объект: изменение DTO не затрагивает участника', () => {
    const manager = new RoomManager();
    const maria = joinOk(manager, 'Мария');

    const dto = manager.toDTO(maria);
    dto.name = 'Подмена';

    expect(dto).not.toBe(maria);
    expect(maria.name).toBe('Мария');
  });
});
