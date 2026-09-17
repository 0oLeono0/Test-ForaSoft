// Индикаторы микрофона и камеры на настоящем сервере (TDD §6.4, §7.4, §11.3): I-10.
import { CLIENT_EVENTS, SERVER_EVENTS } from '@vcr/shared';
import { describe, expect, it } from 'vitest';
import {
  clearReceivedEvents,
  connectAndJoin,
  flushEvents,
  payloadsOf,
  receivedEvents,
  startTestServer,
  waitForEvent,
} from './harness.js';

const ROOM_ID = 'V1StGXR8_Z';

const mediaEvent = (participant, audio, video) => ({
  event: SERVER_EVENTS.PARTICIPANT_MEDIA,
  payload: { participantId: participant.id, audio, video },
});

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

describe('I-10: media:state', () => {
  it('состояние получают все, кроме отправителя, и вошедший позже — в ack', async () => {
    const server = await startTestServer();
    const [maria, alex, olga] = await roomOfThree(server);

    const delivered = waitForEvent(alex.client, SERVER_EVENTS.PARTICIPANT_MEDIA);
    maria.client.emit(CLIENT_EVENTS.MEDIA_STATE, { audio: true, video: false });
    await delivered;
    await flushEvents(maria.client, alex.client, olga.client);

    expect(receivedEvents(alex.client)).toEqual([mediaEvent(maria, true, false)]);
    expect(receivedEvents(olga.client)).toEqual([mediaEvent(maria, true, false)]);
    expect(receivedEvents(maria.client)).toEqual([]);
    const ivan = await connectAndJoin(server, ROOM_ID, 'Иван');
    expect(ivan.ack.participants).toEqual([
      { id: maria.id, name: 'Мария', audio: true, video: false },
      { id: alex.id, name: 'Алекс', audio: false, video: false },
      { id: olga.id, name: 'Ольга', audio: false, video: false },
    ]);
  });

  it('тумблеры: остальные получают каждое изменение по порядку, в ack попадает последнее', async () => {
    const server = await startTestServer();
    const [maria, alex] = await roomOfThree(server);
    const states = [
      { audio: true, video: true },
      { audio: true, video: false },
      { audio: false, video: false },
    ];

    const applied = waitForEvent(
      alex.client,
      SERVER_EVENTS.PARTICIPANT_MEDIA,
      () => receivedEvents(alex.client).length === states.length,
    );
    for (const state of states) maria.client.emit(CLIENT_EVENTS.MEDIA_STATE, state);
    await applied;

    expect(payloadsOf(alex.client, SERVER_EVENTS.PARTICIPANT_MEDIA)).toEqual(
      states.map((state) => ({ participantId: maria.id, ...state })),
    );
    const ivan = await connectAndJoin(server, ROOM_ID, 'Иван');
    expect(ivan.ack.participants[0]).toEqual({
      id: maria.id,
      name: 'Мария',
      audio: false,
      video: false,
    });
  });

  it.each([
    ['payload не объект', 'true'],
    ['audio не boolean', { audio: 'yes', video: true }],
    ['без video', { audio: true }],
  ])('%s: событие игнорируется, состояние не меняется', async (_, payload) => {
    const server = await startTestServer();
    const [maria, alex] = await roomOfThree(server);

    maria.client.emit(CLIENT_EVENTS.MEDIA_STATE, payload);
    maria.client.emit(CLIENT_EVENTS.MEDIA_STATE, { audio: true, video: true });
    await waitForEvent(alex.client, SERVER_EVENTS.PARTICIPANT_MEDIA);
    await flushEvents(alex.client);

    // Дошло только корректное событие, отправленное вторым.
    expect(receivedEvents(alex.client)).toEqual([mediaEvent(maria, true, true)]);
  });

  it('participantId из payload игнорируется: меняется состояние отправителя', async () => {
    const server = await startTestServer();
    const [maria, alex] = await roomOfThree(server);
    alex.client.emit(CLIENT_EVENTS.MEDIA_STATE, { audio: true, video: true });
    await waitForEvent(maria.client, SERVER_EVENTS.PARTICIPANT_MEDIA);
    clearReceivedEvents(maria.client, alex.client);

    const delivered = waitForEvent(alex.client, SERVER_EVENTS.PARTICIPANT_MEDIA);
    maria.client.emit(CLIENT_EVENTS.MEDIA_STATE, {
      audio: true,
      video: false,
      participantId: alex.id,
    });

    expect(await delivered).toEqual({ participantId: maria.id, audio: true, video: false });
    const ivan = await connectAndJoin(server, ROOM_ID, 'Иван');
    expect(ivan.ack.participants.slice(0, 2)).toEqual([
      { id: maria.id, name: 'Мария', audio: true, video: false },
      { id: alex.id, name: 'Алекс', audio: true, video: true },
    ]);
  });
});
