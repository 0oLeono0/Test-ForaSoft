import { describe, expect, it } from 'vitest';
import { CLIENT_EVENTS, SERVER_EVENTS } from './events.js';

// Зарезервированы Socket.io: emit с таким именем выбрасывает ошибку или ломает протокол.
const SOCKET_IO_RESERVED = [
  'connect',
  'connect_error',
  'disconnect',
  'disconnecting',
  'newListener',
  'removeListener',
];

describe.each([
  // Таблица TDD §6.3
  [
    'CLIENT_EVENTS',
    CLIENT_EVENTS,
    ['room:join', 'room:leave', 'chat:send', 'media:state', 'signal'],
  ],
  // Таблица TDD §6.4
  [
    'SERVER_EVENTS',
    SERVER_EVENTS,
    [
      'participant:joined',
      'participant:left',
      'participant:media',
      'chat:message',
      'signal',
      'signal:error',
    ],
  ],
])('%s', (_name, events, designNames) => {
  const names = Object.values(events);

  it('совпадает с таблицей TDD', () => {
    expect(names).toEqual(designNames);
  });

  it('имена уникальны', () => {
    expect(new Set(names).size).toBe(names.length);
  });

  it('не пересекается с зарезервированными событиями Socket.io', () => {
    expect(names.filter((name) => SOCKET_IO_RESERVED.includes(name))).toEqual([]);
  });

  it('заморожен', () => {
    expect(Object.isFrozen(events)).toBe(true);
  });
});

describe('направления событий', () => {
  it('общее имя у двух словарей только одно — ретранслируемый signal', () => {
    const serverNames = Object.values(SERVER_EVENTS);
    const shared = Object.values(CLIENT_EVENTS).filter((name) => serverNames.includes(name));
    expect(shared).toEqual(['signal']);
  });
});
