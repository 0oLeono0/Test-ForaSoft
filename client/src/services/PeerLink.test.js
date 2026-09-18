import { afterEach, describe, expect, it, vi } from 'vitest';
import { LINK_STATUS } from '../state/roomReducer.js';
import { PEER_CONNECT_TIMEOUT_MS, PeerLink } from './PeerLink.js';

const PEER_ID = '4f2a';

/**
 * Трансивер с наблюдаемой сменой направления: присваивание `direction` попадает в журнал
 * вызовов, чтобы проверить порядок шагов из TDD §4.1.4.
 */
function makeTransceiver(kind, initialDirection, calls) {
  const transceiver = {
    receiver: { track: { kind, id: `remote-${kind}` } },
    sender: {
      replaceTrack: vi.fn(async (track) => {
        calls.push(`replaceTrack:${kind}:${track === null ? 'null' : track.id}`);
      }),
    },
  };
  let direction = initialDirection;
  Object.defineProperty(transceiver, 'direction', {
    get: () => direction,
    set: (value) => {
      direction = value;
      calls.push(`direction:${kind}:${value}`);
    },
  });
  return transceiver;
}

/** Мок `RTCPeerConnection`: журнал вызовов и ручное управление состоянием соединения. */
function createPeerConnectionMock() {
  const calls = [];
  const transceivers = [];

  const pc = {
    connectionState: 'new',
    onicecandidate: null,
    onconnectionstatechange: null,
    remoteDescription: null,
    calls,
    transceivers,

    addTransceiver: vi.fn((kind, init) => {
      calls.push(`addTransceiver:${kind}:${init.direction}`);
      const transceiver = makeTransceiver(kind, init.direction, calls);
      transceivers.push(transceiver);
      return transceiver;
    }),
    createOffer: vi.fn(async () => {
      calls.push('createOffer');
      return { type: 'offer', sdp: 'offer-sdp' };
    }),
    createAnswer: vi.fn(async () => {
      calls.push('createAnswer');
      return { type: 'answer', sdp: 'answer-sdp' };
    }),
    setLocalDescription: vi.fn(async () => {
      calls.push('setLocalDescription');
    }),
    setRemoteDescription: vi.fn(async (description) => {
      calls.push('setRemoteDescription');
      pc.remoteDescription = description;
      // Под m-строки чужого offer браузер сам создаёт трансиверы (пока recvonly).
      if (description.type === 'offer') {
        for (const kind of ['audio', 'video']) {
          transceivers.push(makeTransceiver(kind, 'recvonly', calls));
        }
      }
    }),
    addIceCandidate: vi.fn(async () => {}),
    getTransceivers: vi.fn(() => transceivers),
    getReceivers: vi.fn(() => transceivers.map((transceiver) => transceiver.receiver)),
    close: vi.fn(() => {
      calls.push('close');
    }),

    /** Браузер нашёл локальный кандидат; `null` — end-of-candidates. */
    emitCandidate(candidate) {
      pc.onicecandidate?.({ candidate });
    },
    setConnectionState(state) {
      pc.connectionState = state;
      pc.onconnectionstatechange?.();
    },
  };
  return pc;
}

function localTrack(kind) {
  return { kind, id: `local-${kind}` };
}

/**
 * @param {{ role?: 'offerer'|'answerer', tracks?: object }} [options]
 */
function setup({ role = 'offerer', tracks = {} } = {}) {
  const pc = createPeerConnectionMock();
  const sendSignal = vi.fn();
  const onStatus = vi.fn();
  const deps = {
    sendSignal,
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    getLocalTrack: (kind) => tracks[kind] ?? null,
    createPeerConnection: vi.fn(() => pc),
    createMediaStream: vi.fn((streamTracks) => ({ tracks: streamTracks })),
  };
  const link =
    role === 'offerer'
      ? PeerLink.createOfferer(PEER_ID, deps)
      : PeerLink.createAnswerer(PEER_ID, deps);
  link.onStatus(onStatus);

  return { link, pc, sendSignal, onStatus, deps };
}

/** Offer от пира в том виде, в каком его пересылает сервер (TDD §6.3). */
const OFFER = Object.freeze({ type: 'offer', sdp: 'remote-offer-sdp' });
const ANSWER = Object.freeze({ type: 'answer', sdp: 'remote-answer-sdp' });

function candidateSignal(candidate) {
  return { type: 'candidate', candidate };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PeerLink.createOfferer (TDD §4.1.4)', () => {
  it('трансиверы, дорожки и единственный offer в правильном порядке', async () => {
    const { link, pc, sendSignal } = setup({
      tracks: { audio: localTrack('audio'), video: localTrack('video') },
    });

    await link.start();

    expect(pc.calls).toEqual([
      'addTransceiver:audio:sendrecv',
      'replaceTrack:audio:local-audio',
      'addTransceiver:video:sendrecv',
      'replaceTrack:video:local-video',
      'createOffer',
      'setLocalDescription',
    ]);
    expect(sendSignal).toHaveBeenCalledExactlyOnceWith(PEER_ID, {
      type: 'offer',
      sdp: 'offer-sdp',
    });
    expect(link.status).toBe(LINK_STATUS.CONNECTING);
  });

  it('offer уходит, не дожидаясь разрешений на камеру и микрофон (TDD §7.2)', async () => {
    const { link, pc, sendSignal } = setup();

    await link.start();

    expect(pc.calls).toContain('replaceTrack:audio:null');
    expect(pc.calls).toContain('replaceTrack:video:null');
    expect(sendSignal).toHaveBeenCalledWith(PEER_ID, { type: 'offer', sdp: 'offer-sdp' });
  });

  it('повторный start ничего не делает: согласование на пару одно (TDD §3.2)', async () => {
    const { link, pc, sendSignal } = setup();

    await link.start();
    await link.start();

    expect(pc.createOffer).toHaveBeenCalledTimes(1);
    expect(sendSignal).toHaveBeenCalledTimes(1);
  });

  it('answer применяется, и поток пира собирается из приёмников', async () => {
    const { link, pc, deps } = setup();
    await link.start();

    await link.handleSignal(ANSWER);

    expect(pc.setRemoteDescription).toHaveBeenCalledWith(ANSWER);
    expect(deps.createMediaStream).toHaveBeenCalledWith([
      { kind: 'audio', id: 'remote-audio' },
      { kind: 'video', id: 'remote-video' },
    ]);
    expect(link.remoteStream.tracks).toHaveLength(2);
  });

  it('чужой offer игнорируется: роль offerer не отвечает', async () => {
    const { link, pc } = setup();
    await link.start();

    await link.handleSignal(OFFER);

    expect(pc.createAnswer).not.toHaveBeenCalled();
  });

  it('ошибка согласования переводит пару в failed (FR-34)', async () => {
    const { link, pc, onStatus } = setup();
    const failure = new Error('createOffer не удался');
    pc.createOffer.mockRejectedValue(failure);

    await link.start();

    expect(link.status).toBe(LINK_STATUS.FAILED);
    expect(link.lastError).toBe(failure);
    expect(onStatus).toHaveBeenCalledWith(LINK_STATUS.FAILED);
  });
});

describe('PeerLink.createAnswerer (TDD §4.1.4)', () => {
  it('описание → sendrecv с дорожками → answer', async () => {
    const { link, pc, sendSignal } = setup({
      role: 'answerer',
      tracks: { audio: localTrack('audio') },
    });

    await link.handleSignal(OFFER);

    expect(pc.calls).toEqual([
      'setRemoteDescription',
      // Трансиверы приходят из offer как recvonly: без sendrecv пир нас не услышит.
      'direction:audio:sendrecv',
      'replaceTrack:audio:local-audio',
      'direction:video:sendrecv',
      'replaceTrack:video:null',
      'createAnswer',
      'setLocalDescription',
    ]);
    expect(sendSignal).toHaveBeenCalledExactlyOnceWith(PEER_ID, {
      type: 'answer',
      sdp: 'answer-sdp',
    });
    expect(link.remoteStream.tracks).toHaveLength(2);
  });

  it('повторный offer в том же link игнорируется (пересоздание — дело PeerMesh)', async () => {
    const { link, pc } = setup({ role: 'answerer' });
    await link.handleSignal(OFFER);

    await link.handleSignal({ type: 'offer', sdp: 'второй-offer' });

    expect(pc.createAnswer).toHaveBeenCalledTimes(1);
  });

  it('answer в роли answerer игнорируется', async () => {
    const { link, pc } = setup({ role: 'answerer' });

    await link.handleSignal(ANSWER);

    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
  });
});

describe('PeerLink: ICE-кандидаты (TDD §7.2, правило 1)', () => {
  it('кандидаты до описания ждут в очереди и применяются по порядку', async () => {
    const { link, pc } = setup({ role: 'answerer' });

    await link.handleSignal(candidateSignal({ candidate: 'первый' }));
    await link.handleSignal(candidateSignal({ candidate: 'второй' }));
    expect(pc.addIceCandidate).not.toHaveBeenCalled();

    await link.handleSignal(OFFER);

    expect(pc.addIceCandidate.mock.calls).toEqual([
      [{ candidate: 'первый' }],
      [{ candidate: 'второй' }],
    ]);
  });

  it('после описания кандидат применяется сразу', async () => {
    const { link, pc } = setup({ role: 'answerer' });
    await link.handleSignal(OFFER);

    await link.handleSignal(candidateSignal({ candidate: 'поздний' }));

    expect(pc.addIceCandidate).toHaveBeenCalledWith({ candidate: 'поздний' });
  });

  it('candidate: null — end-of-candidates: вызов без аргумента (TDD §6.3)', async () => {
    const { link, pc } = setup({ role: 'answerer' });
    await link.handleSignal(OFFER);

    await link.handleSignal(candidateSignal(null));

    expect(pc.addIceCandidate).toHaveBeenCalledWith(undefined);
  });

  it('неприменимый кандидат пару не роняет', async () => {
    const { link, pc } = setup({ role: 'answerer' });
    await link.handleSignal(OFFER);
    pc.addIceCandidate.mockRejectedValue(new Error('устаревший кандидат'));

    await link.handleSignal(candidateSignal({ candidate: 'мусор' }));

    expect(link.status).toBe(LINK_STATUS.CONNECTING);
  });

  it('свои кандидаты уходят пиру обычным JSON', async () => {
    const { link, pc, sendSignal } = setup();
    await link.start();
    sendSignal.mockClear();

    pc.emitCandidate({ toJSON: () => ({ candidate: 'host 1', sdpMLineIndex: 0 }) });
    pc.emitCandidate(null);

    expect(sendSignal.mock.calls).toEqual([
      [PEER_ID, { type: 'candidate', candidate: { candidate: 'host 1', sdpMLineIndex: 0 } }],
      [PEER_ID, { type: 'candidate', candidate: null }],
    ]);
  });
});

describe('PeerLink: статус соединения (FR-34, TDD §7.2, правило 4)', () => {
  it('connected снимает таймаут', () => {
    vi.useFakeTimers();
    const { link, pc, onStatus } = setup();

    pc.setConnectionState('connected');
    vi.advanceTimersByTime(PEER_CONNECT_TIMEOUT_MS * 2);

    expect(link.status).toBe(LINK_STATUS.CONNECTED);
    expect(onStatus).toHaveBeenCalledExactlyOnceWith(LINK_STATUS.CONNECTED);
  });

  it('нет connected за 15 с → failed', () => {
    vi.useFakeTimers();
    const { link, onStatus } = setup();

    vi.advanceTimersByTime(PEER_CONNECT_TIMEOUT_MS);

    expect(link.status).toBe(LINK_STATUS.FAILED);
    expect(onStatus).toHaveBeenCalledWith(LINK_STATUS.FAILED);
  });

  it('connectionState=failed → failed', () => {
    const { link, pc, onStatus } = setup();

    pc.setConnectionState('failed');

    expect(link.status).toBe(LINK_STATUS.FAILED);
    expect(onStatus).toHaveBeenCalledWith(LINK_STATUS.FAILED);
  });

  it('disconnected — временная потеря, статус не меняется', () => {
    const { link, pc, onStatus } = setup();

    pc.setConnectionState('disconnected');

    expect(link.status).toBe(LINK_STATUS.CONNECTING);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('отписка снимает обработчик статуса', () => {
    const { link, pc } = setup();
    const handler = vi.fn();
    const unsubscribe = link.onStatus(handler);

    unsubscribe();
    pc.setConnectionState('connected');

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('PeerLink.replaceTrack (TDD §7.4)', () => {
  it('новая дорожка доходит до отправителя без нового SDP', async () => {
    const { link, pc } = setup();
    await link.start();
    pc.calls.length = 0;

    await link.replaceTrack('video', localTrack('video'));

    expect(pc.calls).toEqual(['replaceTrack:video:local-video']);
    expect(pc.createOffer).toHaveBeenCalledTimes(1);
  });

  it('выключенная камера рассылается как null', async () => {
    const { link, pc } = setup({ tracks: { video: localTrack('video') } });
    await link.start();
    pc.calls.length = 0;

    await link.replaceTrack('video', null);

    expect(pc.calls).toEqual(['replaceTrack:video:null']);
  });

  it('до трансиверов ничего не делает: дорожку возьмут при их создании', async () => {
    const { link, pc } = setup();

    await link.replaceTrack('audio', localTrack('audio'));

    expect(pc.calls).toEqual([]);
  });

  it('отказ replaceTrack пару не роняет', async () => {
    const { link, pc } = setup();
    await link.start();
    pc.transceivers[0].sender.replaceTrack.mockRejectedValue(new Error('несовместимая дорожка'));

    await link.replaceTrack('audio', localTrack('audio'));

    expect(link.status).toBe(LINK_STATUS.CONNECTING);
  });
});

describe('PeerLink.close', () => {
  it('закрывает соединение и молчит о статусе', async () => {
    const { link, pc, onStatus } = setup();
    await link.start();

    link.close();

    expect(pc.close).toHaveBeenCalledTimes(1);
    expect(pc.onicecandidate).toBeNull();
    expect(pc.onconnectionstatechange).toBeNull();
    expect(link.status).toBe(LINK_STATUS.CLOSED);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('идемпотентен', () => {
    const { link, pc } = setup();

    link.close();
    link.close();

    expect(pc.close).toHaveBeenCalledTimes(1);
  });

  it('после закрытия сигналы и дорожки игнорируются', async () => {
    const { link, pc, sendSignal } = setup({ role: 'answerer' });

    link.close();
    await link.handleSignal(OFFER);
    await link.replaceTrack('audio', localTrack('audio'));

    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    expect(sendSignal).not.toHaveBeenCalled();
  });

  it('закрытие во время согласования не даёт отправить offer', async () => {
    const { link, pc, sendSignal } = setup();
    pc.createOffer.mockImplementation(async () => {
      link.close();
      return { type: 'offer', sdp: 'offer-sdp' };
    });

    await link.start();

    expect(sendSignal).not.toHaveBeenCalled();
  });
});
