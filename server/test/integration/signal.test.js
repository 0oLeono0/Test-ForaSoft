// Пересылка сигналинга WebRTC на настоящем сервере (TDD §6.5, §10.1, §11.3): I-8.
import { CLIENT_EVENTS, ERROR_CODES, SERVER_EVENTS } from '@vcr/shared';
import { describe, expect, it } from 'vitest';
import { SDP_MAX_LENGTH } from '../../src/socket/validatePayload.js';
import {
  clearReceivedEvents,
  connectAndJoin,
  flushEvents,
  receivedEvents,
  request,
  startTestServer,
  waitForEvent,
} from './harness.js';

const ROOM_ID = 'V1StGXR8_Z';

const OFFER = { type: 'offer', sdp: 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\n' };
const ANSWER = { type: 'answer', sdp: 'v=0\r\no=- 7788990011223344556 2 IN IP4 127.0.0.1\r\n' };
const CANDIDATE = {
  type: 'candidate',
  candidate: {
    candidate: 'candidate:1 1 udp 2113937151 192.168.1.50 54321 typ host',
    sdpMid: '0',
    sdpMLineIndex: 0,
    usernameFragment: 'a1b2c3d4',
  },
};
/** `candidate: null` — кандидатов больше не будет (TDD §6.3). */
const END_OF_CANDIDATES = { type: 'candidate', candidate: null };

const signalEvent = (from, data) => ({ event: SERVER_EVENTS.SIGNAL, payload: { from, data } });
const signalError = (to, code) => ({ event: SERVER_EVENTS.SIGNAL_ERROR, payload: { to, code } });

/** Трое в одной комнате; журналы событий очищены. */
async function roomOfThree(server) {
  const members = [];
  for (const name of ['Мария', 'Алекс', 'Ольга']) {
    members.push(await connectAndJoin(server, ROOM_ID, name));
  }
  const clients = members.map((member) => member.client);
  await flushEvents(...clients);
  clearReceivedEvents(...clients);
  return members;
}

describe('I-8: пересылка сигналов участнику своей комнаты', () => {
  it.each([
    ['offer', OFFER],
    ['answer', ANSWER],
    ['candidate', CANDIDATE],
    ['end-of-candidates', END_OF_CANDIDATES],
  ])('%s доходит без изменений только получателю, from ставит сервер', async (_, data) => {
    const server = await startTestServer();
    const [maria, alex, olga] = await roomOfThree(server);

    const delivered = waitForEvent(alex.client, SERVER_EVENTS.SIGNAL);
    maria.client.emit(CLIENT_EVENTS.SIGNAL, { to: alex.id, data });
    await delivered;
    await flushEvents(maria.client, alex.client, olga.client);

    expect(receivedEvents(alex.client)).toEqual([signalEvent(maria.id, data)]);
    expect(receivedEvents(maria.client)).toEqual([]);
    expect(receivedEvents(olga.client)).toEqual([]);
  });

  it('from из payload и лишние поля в data отбрасываются', async () => {
    const server = await startTestServer();
    const [maria, alex, olga] = await roomOfThree(server);

    const delivered = waitForEvent(alex.client, SERVER_EVENTS.SIGNAL);
    maria.client.emit(CLIENT_EVENTS.SIGNAL, {
      to: alex.id,
      from: olga.id,
      data: { ...OFFER, extra: 'подделка' },
    });

    expect(await delivered).toEqual({ from: maria.id, data: OFFER });
  });

  it('согласование mesh: новичок отправляет offer каждому, оба отвечают ему answer', async () => {
    const server = await startTestServer();
    const maria = await connectAndJoin(server, ROOM_ID, 'Мария');
    const alex = await connectAndJoin(server, ROOM_ID, 'Алекс');
    const olga = await connectAndJoin(server, ROOM_ID, 'Ольга');
    clearReceivedEvents(maria.client, alex.client, olga.client);

    // Как в TDD §7.2: offer шлёт вошедший позже — всем из снимка комнаты в ack.
    // Ответы идут от двух других сокетов, поэтому их ждём по событиям, а не flushEvents.
    const answers = waitForEvent(
      olga.client,
      SERVER_EVENTS.SIGNAL,
      () => receivedEvents(olga.client).length === 4,
    );
    for (const { id } of olga.ack.participants) {
      olga.client.emit(CLIENT_EVENTS.SIGNAL, { to: id, data: OFFER });
    }
    for (const member of [maria, alex]) {
      const offer = await waitForEvent(member.client, SERVER_EVENTS.SIGNAL);
      expect(offer).toEqual({ from: olga.id, data: OFFER });
      member.client.emit(CLIENT_EVENTS.SIGNAL, { to: olga.id, data: ANSWER });
      member.client.emit(CLIENT_EVENTS.SIGNAL, { to: olga.id, data: END_OF_CANDIDATES });
    }
    await answers;
    await flushEvents(maria.client, alex.client, olga.client);

    expect(receivedEvents(olga.client)).toEqual(
      expect.arrayContaining([
        signalEvent(maria.id, ANSWER),
        signalEvent(maria.id, END_OF_CANDIDATES),
        signalEvent(alex.id, ANSWER),
        signalEvent(alex.id, END_OF_CANDIDATES),
      ]),
    );
    expect(receivedEvents(olga.client)).toHaveLength(4);
    expect(receivedEvents(maria.client)).toEqual([signalEvent(olga.id, OFFER)]);
    expect(receivedEvents(alex.client)).toEqual([signalEvent(olga.id, OFFER)]);
  });
});

describe('I-8: получатель недоступен', () => {
  it('участник другой комнаты — PEER_NOT_FOUND, он ничего не получает', async () => {
    const server = await startTestServer();
    const [maria] = await roomOfThree(server);
    const outsider = await connectAndJoin(server, 'other-room', 'Иван');
    clearReceivedEvents(outsider.client);

    const rejected = waitForEvent(maria.client, SERVER_EVENTS.SIGNAL_ERROR);
    maria.client.emit(CLIENT_EVENTS.SIGNAL, { to: outsider.id, data: OFFER });
    await rejected;
    await flushEvents(maria.client, outsider.client);

    expect(receivedEvents(maria.client)).toEqual([
      signalError(outsider.id, ERROR_CODES.PEER_NOT_FOUND),
    ]);
    expect(receivedEvents(outsider.client)).toEqual([]);
  });

  it.each([
    ['неизвестный id', (members) => `${members[0].id.slice(0, -1)}0`],
    ['сам отправитель', (members) => members[0].id],
  ])('%s — PEER_NOT_FOUND', async (_, pickTarget) => {
    const server = await startTestServer();
    const members = await roomOfThree(server);
    const [maria] = members;
    const to = pickTarget(members);

    const rejected = waitForEvent(maria.client, SERVER_EVENTS.SIGNAL_ERROR);
    maria.client.emit(CLIENT_EVENTS.SIGNAL, { to, data: OFFER });

    expect(await rejected).toEqual({ to, code: ERROR_CODES.PEER_NOT_FOUND });
  });

  it('участник вышел во время согласования — PEER_NOT_FOUND', async () => {
    const server = await startTestServer();
    const [maria, alex] = await roomOfThree(server);
    await request(alex.client, CLIENT_EVENTS.ROOM_LEAVE);
    clearReceivedEvents(maria.client);

    const rejected = waitForEvent(maria.client, SERVER_EVENTS.SIGNAL_ERROR);
    maria.client.emit(CLIENT_EVENTS.SIGNAL, { to: alex.id, data: CANDIDATE });
    await rejected;
    await flushEvents(maria.client, alex.client);

    expect(receivedEvents(maria.client)).toEqual([
      signalError(alex.id, ERROR_CODES.PEER_NOT_FOUND),
    ]);
    expect(receivedEvents(alex.client)).toEqual([]);
  });
});

describe('I-8: некорректные данные сигналинга', () => {
  it.each([
    ['неизвестный type', { type: 'bogus', sdp: 'v=0' }],
    ['offer без sdp', { type: 'offer' }],
    ['пустой sdp', { type: 'offer', sdp: '' }],
    ['sdp не строка', { type: 'offer', sdp: 42 }],
    ['candidate строкой', { type: 'candidate', candidate: 'candidate:1 1 udp' }],
    ['sdp длиннее лимита', { type: 'offer', sdp: 'v'.repeat(SDP_MAX_LENGTH + 1) }],
  ])('%s — INVALID_SIGNAL отправителю с его to, получатель ничего не получает', async (_, data) => {
    const server = await startTestServer();
    const [maria, alex] = await roomOfThree(server);

    const rejected = waitForEvent(maria.client, SERVER_EVENTS.SIGNAL_ERROR);
    maria.client.emit(CLIENT_EVENTS.SIGNAL, { to: alex.id, data });
    await rejected;
    await flushEvents(maria.client, alex.client);

    expect(receivedEvents(maria.client)).toEqual([
      signalError(alex.id, ERROR_CODES.INVALID_SIGNAL),
    ]);
    expect(receivedEvents(alex.client)).toEqual([]);
  });

  it.each([
    ['payload не объект', 'offer'],
    ['без to', { data: OFFER }],
    ['to не строка', { to: 42, data: OFFER }],
    ['to длиннее 64 символов', { to: 'x'.repeat(65), data: OFFER }],
  ])('%s — INVALID_SIGNAL с to: null', async (_, payload) => {
    const server = await startTestServer();
    const [maria] = await roomOfThree(server);

    const rejected = waitForEvent(maria.client, SERVER_EVENTS.SIGNAL_ERROR);
    maria.client.emit(CLIENT_EVENTS.SIGNAL, payload);

    expect(await rejected).toEqual({ to: null, code: ERROR_CODES.INVALID_SIGNAL });
  });
});
