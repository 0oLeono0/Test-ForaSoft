import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT_ERROR_CODES } from '../utils/mediaErrors.js';
import { checkSupport } from './environment.js';

/** jsdom отдаёт эти поля только для чтения — подменяем дескриптором и возвращаем как было. */
const overridden = [];

function override(target, property, value) {
  overridden.push([target, property, Object.getOwnPropertyDescriptor(target, property)]);
  Object.defineProperty(target, property, { value, configurable: true, writable: true });
}

/** Окружение, в котором все проверки проходят: защищённый контекст и полный WebRTC. */
function supportedEnvironment() {
  override(window, 'isSecureContext', true);
  override(window, 'RTCPeerConnection', function RTCPeerConnectionStub() {});
  override(navigator, 'mediaDevices', { getUserMedia() {} });
}

afterEach(() => {
  for (const [target, property, descriptor] of overridden.reverse()) {
    if (descriptor === undefined) delete target[property];
    else Object.defineProperty(target, property, descriptor);
  }
  overridden.length = 0;
});

describe('checkSupport', () => {
  it('защищённый контекст и полный WebRTC: поддержка есть', () => {
    supportedEnvironment();

    expect(checkSupport()).toEqual({ ok: true });
  });

  it('незащищённый контекст: INSECURE_CONTEXT (PRD §7)', () => {
    supportedEnvironment();
    override(window, 'isSecureContext', false);

    expect(checkSupport()).toEqual({ ok: false, reason: CLIENT_ERROR_CODES.INSECURE_CONTEXT });
  });

  it.each([
    ['нет RTCPeerConnection', () => override(window, 'RTCPeerConnection', undefined)],
    ['нет mediaDevices', () => override(navigator, 'mediaDevices', undefined)],
    ['нет getUserMedia', () => override(navigator, 'mediaDevices', {})],
  ])('%s: WEBRTC_UNSUPPORTED (FR-36)', (_, breakSupport) => {
    supportedEnvironment();
    breakSupport();

    expect(checkSupport()).toEqual({ ok: false, reason: CLIENT_ERROR_CODES.WEBRTC_UNSUPPORTED });
  });

  it('http://<LAN-IP> без mediaDevices: сначала HTTPS, потом WebRTC (TDD §4.1.2)', () => {
    // Браузер не создаёт `navigator.mediaDevices` в незащищённом контексте: если проверить
    // поддержку раньше, пользователь чинил бы не ту проблему.
    supportedEnvironment();
    override(window, 'isSecureContext', false);
    override(navigator, 'mediaDevices', undefined);

    expect(checkSupport()).toEqual({ ok: false, reason: CLIENT_ERROR_CODES.INSECURE_CONTEXT });
  });
});
