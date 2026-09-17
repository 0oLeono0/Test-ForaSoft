import { ERROR_CODES } from '@vcr/shared';
import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_MAX_LENGTH,
  PEER_ID_MAX_LENGTH,
  SDP_MAX_LENGTH,
  validate,
} from './validatePayload.js';

const INVALID = { ok: false, code: ERROR_CODES.INVALID_PAYLOAD };

const PEER_ID = '4f2a0c1e-8b7d-4c3a-9e6f-1a2b3c4d5e6f';
const SDP = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
const CANDIDATE_INIT = {
  candidate:
    'candidate:842163049 1 udp 1677729535 192.168.1.50 54321 typ srflx raddr 0.0.0.0 rport 0 generation 0',
  sdpMid: '0',
  sdpMLineIndex: 0,
  usernameFragment: 'EsAw',
};

const VALID_PAYLOADS = {
  join: { roomId: 'V1StGXR8_Z', name: 'Алекс' },
  chat: { text: 'Привет' },
  media: { audio: true, video: false },
  signal: { to: PEER_ID, data: { type: 'offer', sdp: SDP } },
};

function signal(data, to = PEER_ID) {
  return validate('signal', { to, data });
}

function candidate(init) {
  return signal({ type: 'candidate', candidate: init });
}

describe('validate: общие правила', () => {
  it.each(['unknown', 'toString', '__proto__', ''])('неизвестная схема %j — ошибка', (schema) => {
    expect(() => validate(schema, {})).toThrow('Неизвестная схема payload');
  });

  describe.each(Object.keys(VALID_PAYLOADS))('%s', (schema) => {
    const valid = VALID_PAYLOADS[schema];

    it.each([
      ['undefined', undefined],
      ['null', null],
      ['строка', JSON.stringify(valid)],
      ['число', 42],
      ['boolean', true],
      ['массив', [valid]],
      ['Buffer', Buffer.from(JSON.stringify(valid))],
      ['Date', new Date(0)],
      ['экземпляр класса', Object.assign(new (class Payload {})(), valid)],
    ])('payload не объект (%s) → INVALID_PAYLOAD', (_label, payload) => {
      expect(validate(schema, payload)).toEqual(INVALID);
    });

    it('пустой объект → INVALID_PAYLOAD', () => {
      expect(validate(schema, {})).toEqual(INVALID);
    });

    it('валидный payload принимается как новый объект', () => {
      const result = validate(schema, valid);

      expect(result).toEqual({ ok: true, value: valid });
      expect(result.value).not.toBe(valid);
    });

    it('принимает объект без прототипа', () => {
      const payload = Object.assign(Object.create(null), valid);

      expect(validate(schema, payload)).toEqual({ ok: true, value: valid });
    });

    it('отбрасывает лишние поля, в том числе __proto__ из JSON', () => {
      const payload = JSON.parse(
        JSON.stringify({ ...valid, extra: 1, participantId: 'x' }).replace(
          /^\{/,
          '{"__proto__":{"polluted":true},',
        ),
      );
      expect(Object.hasOwn(payload, '__proto__')).toBe(true);

      const result = validate(schema, payload);

      expect(result).toEqual({ ok: true, value: valid });
      expect(Object.keys(result.value)).toEqual(Object.keys(valid));
      expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    });
  });
});

describe('validate: join', () => {
  it.each([
    ['roomId — число', { roomId: 123, name: 'Алекс' }],
    ['roomId — null', { roomId: null, name: 'Алекс' }],
    ['roomId — массив', { roomId: ['abc'], name: 'Алекс' }],
    ['нет roomId', { name: 'Алекс' }],
    ['name — число', { roomId: 'abc', name: 42 }],
    ['name — объект', { roomId: 'abc', name: { first: 'Алекс' } }],
    ['нет name', { roomId: 'abc' }],
  ])('%s → INVALID_PAYLOAD', (_label, payload) => {
    expect(validate('join', payload)).toEqual(INVALID);
  });

  it('содержимое строк не проверяет: это делают isValidRoomId и validateName', () => {
    const payload = { roomId: '../x', name: '<b>' };

    expect(validate('join', payload)).toEqual({ ok: true, value: payload });
    expect(validate('join', { roomId: '', name: '' })).toEqual({
      ok: true,
      value: { roomId: '', name: '' },
    });
  });
});

describe('validate: chat', () => {
  it.each([
    ['text — число', { text: 42 }],
    ['text — null', { text: null }],
    ['text — массив', { text: ['Привет'] }],
    ['text — объект', { text: { toString: 'Привет' } }],
  ])('%s → INVALID_PAYLOAD', (_label, payload) => {
    expect(validate('chat', payload)).toEqual(INVALID);
  });

  it('пустой и длинный текст пропускает: их отклоняет validateMessage', () => {
    for (const text of ['', '   \n  ', 'x'.repeat(5000)]) {
      expect(validate('chat', { text })).toEqual({ ok: true, value: { text } });
    }
  });
});

describe('validate: media', () => {
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])('audio=%s, video=%s принимается', (audio, video) => {
    expect(validate('media', { audio, video })).toEqual({ ok: true, value: { audio, video } });
  });

  it.each([
    ['audio — строка', { audio: 'true', video: true }],
    ['audio — число', { audio: 1, video: true }],
    ['video — число', { audio: true, video: 0 }],
    ['video — null', { audio: true, video: null }],
    ['нет audio', { video: true }],
    ['нет video', { audio: true }],
  ])('%s → INVALID_PAYLOAD', (_label, payload) => {
    expect(validate('media', payload)).toEqual(INVALID);
  });
});

describe('validate: signal — адресат', () => {
  it.each([
    ['число', 42],
    ['null', null],
    ['пустая строка', ''],
    ['массив', [PEER_ID]],
    [`длиннее ${PEER_ID_MAX_LENGTH} символов`, 'a'.repeat(PEER_ID_MAX_LENGTH + 1)],
  ])('to — %s → INVALID_PAYLOAD', (_label, to) => {
    expect(signal({ type: 'offer', sdp: SDP }, to)).toEqual(INVALID);
  });

  it('нет to → INVALID_PAYLOAD', () => {
    expect(validate('signal', { data: { type: 'offer', sdp: SDP } })).toEqual(INVALID);
  });

  it(`to ровно из ${PEER_ID_MAX_LENGTH} символов принимается`, () => {
    const to = 'a'.repeat(PEER_ID_MAX_LENGTH);

    expect(signal({ type: 'offer', sdp: SDP }, to)).toEqual({
      ok: true,
      value: { to, data: { type: 'offer', sdp: SDP } },
    });
  });

  it('поле from из payload отбрасывается: его проставляет сервер', () => {
    const result = validate('signal', {
      to: PEER_ID,
      from: 'forged-id',
      data: { type: 'offer', sdp: SDP, from: 'forged-id' },
    });

    expect(result).toEqual({ ok: true, value: { to: PEER_ID, data: { type: 'offer', sdp: SDP } } });
    expect(result.value).not.toHaveProperty('from');
    expect(result.value.data).not.toHaveProperty('from');
  });
});

describe('validate: signal — данные', () => {
  it.each([
    ['нет data', undefined],
    ['null', null],
    ['строка', 'offer'],
    ['массив', [{ type: 'offer', sdp: SDP }]],
  ])('data — %s → INVALID_PAYLOAD', (_label, data) => {
    expect(signal(data)).toEqual(INVALID);
  });

  it.each([
    ['неизвестный type', { type: 'bye', sdp: SDP }],
    ['type в другом регистре', { type: 'OFFER', sdp: SDP }],
    ['нет type', { sdp: SDP }],
    ['type — число', { type: 1, sdp: SDP }],
    ['type — pranswer', { type: 'pranswer', sdp: SDP }],
  ])('%s → INVALID_PAYLOAD', (_label, data) => {
    expect(signal(data)).toEqual(INVALID);
  });
});

describe.each(['offer', 'answer'])('validate: signal — %s', (type) => {
  it('принимается с sdp, лишние поля отброшены', () => {
    const data = { type, sdp: SDP, candidate: CANDIDATE_INIT, extra: true };
    const result = signal(data);

    expect(result).toEqual({ ok: true, value: { to: PEER_ID, data: { type, sdp: SDP } } });
    expect(result.value.data).not.toBe(data);
  });

  it.each([
    ['нет sdp', undefined],
    ['sdp — null', null],
    ['sdp — число', 42],
    ['sdp — объект', { sdp: SDP }],
    ['пустой sdp', ''],
    [`sdp длиннее ${SDP_MAX_LENGTH}`, 'v'.repeat(SDP_MAX_LENGTH + 1)],
  ])('%s → INVALID_PAYLOAD', (_label, sdp) => {
    expect(signal({ type, sdp })).toEqual(INVALID);
  });

  it(`sdp ровно из ${SDP_MAX_LENGTH} символов принимается`, () => {
    const sdp = 'v'.repeat(SDP_MAX_LENGTH);

    expect(signal({ type, sdp }).ok).toBe(true);
  });
});

describe('validate: signal — candidate', () => {
  it('полный RTCIceCandidateInit принимается как новый объект', () => {
    const result = candidate(CANDIDATE_INIT);

    expect(result).toEqual({
      ok: true,
      value: { to: PEER_ID, data: { type: 'candidate', candidate: CANDIDATE_INIT } },
    });
    expect(result.value.data.candidate).not.toBe(CANDIDATE_INIT);
  });

  it('candidate: null (end-of-candidates) принимается', () => {
    expect(candidate(null)).toEqual({
      ok: true,
      value: { to: PEER_ID, data: { type: 'candidate', candidate: null } },
    });
  });

  it('отсутствующие поля не добавляются, лишние отбрасываются', () => {
    const result = candidate({ candidate: CANDIDATE_INIT.candidate, sdpMid: '0', port: 54321 });

    expect(result.value.data.candidate).toEqual({
      candidate: CANDIDATE_INIT.candidate,
      sdpMid: '0',
    });
    expect(Object.keys(result.value.data.candidate)).toEqual(['candidate', 'sdpMid']);
  });

  it('пустой объект и пустая строка кандидата принимаются (конец кандидатов для m-line)', () => {
    expect(candidate({}).value.data.candidate).toEqual({});
    expect(candidate({ candidate: '', sdpMid: '0' }).ok).toBe(true);
  });

  it('sdpMid, sdpMLineIndex и usernameFragment могут быть null', () => {
    const init = { candidate: '', sdpMid: null, sdpMLineIndex: null, usernameFragment: null };

    expect(candidate(init).value.data.candidate).toEqual(init);
  });

  it(`границы: строки до ${CANDIDATE_MAX_LENGTH} символов, sdpMLineIndex до 65535`, () => {
    const long = 'c'.repeat(CANDIDATE_MAX_LENGTH);
    const init = { candidate: long, sdpMid: long, sdpMLineIndex: 65_535, usernameFragment: long };

    expect(candidate(init).ok).toBe(true);
  });

  it('нет поля candidate → INVALID_PAYLOAD', () => {
    expect(signal({ type: 'candidate' })).toEqual(INVALID);
    expect(signal({ type: 'candidate', sdp: SDP })).toEqual(INVALID);
  });

  it.each([
    ['строка вместо объекта', CANDIDATE_INIT.candidate],
    ['массив', [CANDIDATE_INIT]],
    ['число', 0],
  ])('candidate — %s → INVALID_PAYLOAD', (_label, init) => {
    expect(candidate(init)).toEqual(INVALID);
  });

  it.each([
    ['candidate — null', { candidate: null }],
    ['candidate — число', { candidate: 1 }],
    [
      `candidate длиннее ${CANDIDATE_MAX_LENGTH}`,
      { candidate: 'c'.repeat(CANDIDATE_MAX_LENGTH + 1) },
    ],
    ['sdpMid — число', { sdpMid: 0 }],
    [`sdpMid длиннее ${CANDIDATE_MAX_LENGTH}`, { sdpMid: 'm'.repeat(CANDIDATE_MAX_LENGTH + 1) }],
    ['sdpMLineIndex — строка', { sdpMLineIndex: '0' }],
    ['sdpMLineIndex — отрицательный', { sdpMLineIndex: -1 }],
    ['sdpMLineIndex — дробный', { sdpMLineIndex: 1.5 }],
    ['sdpMLineIndex — NaN', { sdpMLineIndex: NaN }],
    ['sdpMLineIndex больше 65535', { sdpMLineIndex: 65_536 }],
    ['usernameFragment — число', { usernameFragment: 1 }],
    [
      `usernameFragment длиннее ${CANDIDATE_MAX_LENGTH}`,
      { usernameFragment: 'u'.repeat(CANDIDATE_MAX_LENGTH + 1) },
    ],
  ])('%s → INVALID_PAYLOAD', (_label, override) => {
    expect(candidate({ ...CANDIDATE_INIT, ...override })).toEqual(INVALID);
  });
});
