import { describe, expect, it, vi } from 'vitest';
import { LINK_STATUS } from '../state/roomReducer.js';
import { PEER_ROLES } from './PeerLink.js';
import { PeerMesh } from './PeerMesh.js';

const ANNA = 'a1';
const BORIS = 'b2';

const OFFER = Object.freeze({ type: 'offer', sdp: 'offer-sdp' });
const ANSWER = Object.freeze({ type: 'answer', sdp: 'answer-sdp' });
const CANDIDATE = Object.freeze({ type: 'candidate', candidate: { candidate: 'host 1' } });

const ICE_SERVERS = Object.freeze([{ urls: 'stun:stun.l.google.com:19302' }]);

/** Мок `PeerLink`: тот же интерфейс, но без RTCPeerConnection. */
function createLinkMock(peerId, role, deps) {
  const handlers = new Set();
  const link = {
    peerId,
    role,
    deps,
    status: LINK_STATUS.CONNECTING,
    remoteStream: { id: `stream-${peerId}` },
    start: vi.fn(async () => {}),
    handleSignal: vi.fn(async () => {}),
    replaceTrack: vi.fn(async () => {}),
    close: vi.fn(() => {
      link.status = LINK_STATUS.CLOSED;
    }),
    onStatus: vi.fn((handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
    /** ICE дошёл до конца или пара не состоялась. */
    emitStatus(status) {
      link.status = status;
      for (const handler of [...handlers]) handler(status);
    },
  };
  return link;
}

function setup() {
  const created = [];
  const sendSignal = vi.fn();
  const getLocalTrack = vi.fn(() => null);
  const createLink = vi.fn((peerId, role, deps) => {
    const link = createLinkMock(peerId, role, deps);
    created.push(link);
    return link;
  });
  const mesh = new PeerMesh({
    sendSignal,
    iceServers: ICE_SERVERS,
    getLocalTrack,
    createLink,
  });
  const onStatus = vi.fn();
  mesh.onStatus(onStatus);

  return {
    mesh,
    created,
    createLink,
    onStatus,
    sendSignal,
    getLocalTrack,
    /** Последний созданный link для пира. */
    linkFor: (peerId) => created.filter((link) => link.peerId === peerId).at(-1),
  };
}

describe('PeerMesh.connectTo: новичок шлёт offer каждому (TDD §3.2)', () => {
  it('на каждого участника снимка — offerer, и он сразу начинает согласование', () => {
    const { mesh, created, linkFor } = setup();

    mesh.connectTo([ANNA, BORIS]);

    expect(created.map((link) => [link.peerId, link.role])).toEqual([
      [ANNA, PEER_ROLES.OFFERER],
      [BORIS, PEER_ROLES.OFFERER],
    ]);
    expect(linkFor(ANNA).start).toHaveBeenCalledTimes(1);
    expect(mesh.peerIds).toEqual([ANNA, BORIS]);
  });

  it('связь с пиром не дублируется', () => {
    const { mesh, created } = setup();

    mesh.connectTo([ANNA]);
    mesh.connectTo([ANNA, BORIS]);

    expect(created).toHaveLength(2);
    expect(mesh.peerIds).toEqual([ANNA, BORIS]);
  });

  it('link получает sendSignal, iceServers из ack и доступ к локальным дорожкам', () => {
    const { mesh, linkFor, sendSignal, getLocalTrack } = setup();

    mesh.connectTo([ANNA]);

    expect(linkFor(ANNA).deps.sendSignal).toBe(sendSignal);
    expect(linkFor(ANNA).deps.iceServers).toBe(ICE_SERVERS);
    expect(linkFor(ANNA).deps.getLocalTrack).toBe(getLocalTrack);
  });
});

describe('PeerMesh.handleSignal: маршрутизация (TDD §7.2)', () => {
  it('offer от незнакомого пира — это новичок: отвечаем ему', async () => {
    const { mesh, linkFor } = setup();

    await mesh.handleSignal(ANNA, OFFER);

    expect(linkFor(ANNA).role).toBe(PEER_ROLES.ANSWERER);
    expect(linkFor(ANNA).handleSignal).toHaveBeenCalledWith(OFFER);
    // Answerer не начинает согласование сам.
    expect(linkFor(ANNA).start).not.toHaveBeenCalled();
  });

  it('answer и кандидат уходят в существующую пару', async () => {
    const { mesh, linkFor } = setup();
    mesh.connectTo([ANNA]);

    await mesh.handleSignal(ANNA, ANSWER);
    await mesh.handleSignal(ANNA, CANDIDATE);

    expect(linkFor(ANNA).handleSignal.mock.calls).toEqual([[ANSWER], [CANDIDATE]]);
  });

  it('answer без пары игнорируется: соединения для него нет', async () => {
    const { mesh, created } = setup();

    await mesh.handleSignal(ANNA, ANSWER);
    await mesh.handleSignal(ANNA, CANDIDATE);

    expect(created).toHaveLength(0);
  });

  it('повторный offer защитно пересоздаёт пару (TDD §7.2, правило 3)', async () => {
    const { mesh, created } = setup();
    mesh.connectTo([ANNA]);
    const first = created[0];

    await mesh.handleSignal(ANNA, OFFER);

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(2);
    expect(created[1].role).toBe(PEER_ROLES.ANSWERER);
    expect(created[1].handleSignal).toHaveBeenCalledWith(OFFER);
    expect(mesh.peerIds).toEqual([ANNA]);
  });

  it('сигнал от вышедшего участника игнорируется (TDD §7.2, правило 2)', async () => {
    const { mesh, created } = setup();
    mesh.connectTo([ANNA]);
    mesh.removePeer(ANNA);

    await mesh.handleSignal(ANNA, OFFER);
    await mesh.handleSignal(ANNA, CANDIDATE);

    // Новая пара не создаётся: участника в комнате уже нет.
    expect(created).toHaveLength(1);
  });
});

describe('PeerMesh: жизненный цикл соединений', () => {
  it('removePeer закрывает пару и убирает её из реестра (FR-27)', () => {
    const { mesh, linkFor } = setup();
    mesh.connectTo([ANNA, BORIS]);

    mesh.removePeer(ANNA);

    expect(linkFor(ANNA).close).toHaveBeenCalledTimes(1);
    expect(mesh.peerIds).toEqual([BORIS]);
  });

  it('removePeer для незнакомого пира безопасен', () => {
    const { mesh } = setup();

    expect(() => mesh.removePeer('нет-такого')).not.toThrow();
  });

  it('closeAll закрывает всё и больше не подключает (TDD §7.6)', async () => {
    const { mesh, created, linkFor } = setup();
    mesh.connectTo([ANNA, BORIS]);

    mesh.closeAll();
    mesh.connectTo([ANNA]);
    await mesh.handleSignal(BORIS, OFFER);

    expect(linkFor(ANNA).close).toHaveBeenCalledTimes(1);
    expect(linkFor(BORIS).close).toHaveBeenCalledTimes(1);
    expect(mesh.peerIds).toEqual([]);
    expect(created).toHaveLength(2);
  });
});

describe('PeerMesh.broadcastTrack и getStream (TDD §7.4)', () => {
  it('новая дорожка доходит до всех пиров', () => {
    const { mesh, linkFor } = setup();
    mesh.connectTo([ANNA, BORIS]);
    const track = { kind: 'video', id: 'local-video' };

    mesh.broadcastTrack('video', track);

    expect(linkFor(ANNA).replaceTrack).toHaveBeenCalledWith('video', track);
    expect(linkFor(BORIS).replaceTrack).toHaveBeenCalledWith('video', track);
  });

  it('выключенная камера рассылается как null', () => {
    const { mesh, linkFor } = setup();
    mesh.connectTo([ANNA]);

    mesh.broadcastTrack('video', null);

    expect(linkFor(ANNA).replaceTrack).toHaveBeenCalledWith('video', null);
  });

  it('getStream отдаёт поток пира, а для незнакомого — null', () => {
    const { mesh } = setup();
    mesh.connectTo([ANNA]);

    expect(mesh.getStream(ANNA)).toEqual({ id: `stream-${ANNA}` });
    expect(mesh.getStream(BORIS)).toBeNull();
  });
});

describe('PeerMesh: события статуса (FR-34, TDD §4.1.6)', () => {
  it('новая пара сразу сообщает connecting', () => {
    const { mesh, onStatus } = setup();

    mesh.connectTo([ANNA]);

    expect(onStatus).toHaveBeenCalledExactlyOnceWith(ANNA, LINK_STATUS.CONNECTING);
  });

  it('смена статуса пары доходит с её peerId', () => {
    const { mesh, linkFor, onStatus } = setup();
    mesh.connectTo([ANNA, BORIS]);
    onStatus.mockClear();

    linkFor(BORIS).emitStatus(LINK_STATUS.FAILED);

    expect(onStatus).toHaveBeenCalledExactlyOnceWith(BORIS, LINK_STATUS.FAILED);
    expect(mesh.getStatuses()).toEqual({
      [ANNA]: LINK_STATUS.CONNECTING,
      [BORIS]: LINK_STATUS.FAILED,
    });
  });

  it('отписка снимает обработчик', () => {
    const { mesh } = setup();
    const handler = vi.fn();
    const unsubscribe = mesh.onStatus(handler);

    unsubscribe();
    mesh.connectTo([ANNA]);

    expect(handler).not.toHaveBeenCalled();
  });
});
