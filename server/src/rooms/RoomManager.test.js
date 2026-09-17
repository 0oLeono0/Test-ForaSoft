import { ERROR_CODES, MAX_PARTICIPANTS } from '@vcr/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Room } from './Room.js';
import { RoomManager } from './RoomManager.js';

const ROOM_ID = 'V1StGXR8_Z';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
    const fields = ['audio', 'id', 'joinedAt', 'name', 'socketId', 'video'];

    for (const participant of [creator, ...others]) {
      expect(Object.keys(participant).sort()).toEqual(fields);
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
