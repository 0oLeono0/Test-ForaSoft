import { describe, expect, it } from 'vitest';
import { CLIENT_ERROR_CODES, TRACK_STATUS, mapMediaError } from './mediaErrors.js';

/** `getUserMedia` отклоняется `DOMException`; в jsdom он есть. */
function mediaError(name) {
  return new DOMException('Отказано', name);
}

describe('mapMediaError', () => {
  it.each([
    ['NotAllowedError', TRACK_STATUS.DENIED],
    ['SecurityError', TRACK_STATUS.DENIED],
    ['NotFoundError', TRACK_STATUS.NOT_FOUND],
    ['OverconstrainedError', TRACK_STATUS.NOT_FOUND],
    ['NotReadableError', TRACK_STATUS.BUSY],
    ['AbortError', TRACK_STATUS.BUSY],
  ])('%s → %s', (name, status) => {
    expect(mapMediaError(mediaError(name))).toBe(status);
  });

  it.each([
    ['неизвестный DOMException', mediaError('TypeError')],
    ['обычная ошибка', new Error('bang')],
    ['без имени', {}],
    ['null', null],
    ['строка', 'NotAllowedError'],
    ['undefined', undefined],
  ])('%s → ERROR', (_, error) => {
    expect(mapMediaError(error)).toBe(TRACK_STATUS.ERROR);
  });
});

describe('коды клиентских состояний (TDD §8.2)', () => {
  it('ключ совпадает со значением и список заморожен', () => {
    for (const [key, value] of Object.entries(CLIENT_ERROR_CODES)) expect(value).toBe(key);
    expect(Object.isFrozen(CLIENT_ERROR_CODES)).toBe(true);
    expect(Object.isFrozen(TRACK_STATUS)).toBe(true);
  });

  it('перечислены все 11 кодов из §8.2', () => {
    expect(Object.keys(CLIENT_ERROR_CODES)).toEqual([
      'WEBRTC_UNSUPPORTED',
      'INSECURE_CONTEXT',
      'SERVER_UNAVAILABLE',
      'CONNECTION_LOST',
      'MEDIA_DENIED',
      'MEDIA_NOT_FOUND',
      'MEDIA_BUSY',
      'MEDIA_DEVICE_LOST',
      'PEER_LINK_FAILED',
      'AUTOPLAY_BLOCKED',
      'CLIPBOARD_FAILED',
    ]);
  });
});
