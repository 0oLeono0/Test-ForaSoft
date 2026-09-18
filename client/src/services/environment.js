// Проверка окружения перед входом в комнату (TDD §4.1.2, §4.1.3, §8.2).
import { CLIENT_ERROR_CODES } from '../utils/mediaErrors.js';

/**
 * @typedef {{ ok: true }
 *   | { ok: false, reason: 'INSECURE_CONTEXT' | 'WEBRTC_UNSUPPORTED' }} SupportResult
 */

/**
 * Порядок проверок важен (TDD §4.1.2): страница, открытая по `http://<LAN-IP>`, — незащищённый
 * контекст, и `navigator.mediaDevices` там нет даже в Chrome последней версии. Если сначала
 * проверить WebRTC, пользователь увидит неверное «браузер не поддерживает» вместо «откройте
 * по HTTPS» и не поймёт, что чинить.
 * @returns {SupportResult}
 */
export function checkSupport() {
  if (!window.isSecureContext) {
    return { ok: false, reason: CLIENT_ERROR_CODES.INSECURE_CONTEXT };
  }
  const hasPeerConnection = typeof window.RTCPeerConnection === 'function';
  const hasGetUserMedia = typeof navigator.mediaDevices?.getUserMedia === 'function';
  if (!hasPeerConnection || !hasGetUserMedia) {
    return { ok: false, reason: CLIENT_ERROR_CODES.WEBRTC_UNSUPPORTED };
  }
  return { ok: true };
}
