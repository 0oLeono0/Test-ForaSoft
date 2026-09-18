import { afterEach, describe, expect, it } from 'vitest';
import { LINK_STATUS, initialState } from '../state/roomReducer.js';
import { installTestHook } from './testHook.js';

const PARTICIPANTS = [
  { id: 'b7c1', name: 'Алекс', audio: true, video: true },
  { id: '4f2a', name: 'Мария', audio: false, video: true },
];

function roomState(overrides = {}) {
  return {
    ...initialState,
    participants: PARTICIPANTS,
    links: { '4f2a': LINK_STATUS.CONNECTED },
    ...overrides,
  };
}

/** Сессия в объёме, который нужен хуку. */
function sessionStub(local) {
  return { getLocalTracks: () => local };
}

afterEach(() => {
  delete window.__vcr;
});

describe('installTestHook: дев-хук window.__vcr (TDD §11.4)', () => {
  it('отдаёт участников, статусы пар и локальные дорожки', () => {
    const local = { audio: { readyState: 'live', enabled: true }, video: null };

    installTestHook({ state: roomState(), session: sessionStub(local) });

    expect(window.__vcr.participants).toEqual(PARTICIPANTS);
    expect(window.__vcr.links).toEqual({ '4f2a': LINK_STATUS.CONNECTED });
    expect(window.__vcr.local).toEqual(local);
  });

  it('дорожки читаются в момент обращения: React о stop() не знает (FR-19)', () => {
    const track = { readyState: 'live', enabled: true };
    installTestHook({ state: roomState(), session: sessionStub({ audio: null, video: track }) });

    track.readyState = 'ended';

    expect(window.__vcr.local.video.readyState).toBe('ended');
  });

  it('до входа в комнату сессии нет: дорожек тоже', () => {
    installTestHook({ state: initialState, session: null });

    expect(window.__vcr.local).toEqual({ audio: null, video: null });
    expect(window.__vcr.participants).toEqual([]);
  });

  it('снятие хука убирает свойство: страница закрылась', () => {
    const uninstall = installTestHook({ state: roomState(), session: null });

    uninstall();

    expect(window.__vcr).toBeUndefined();
  });
});
