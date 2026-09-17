// Dev-сервер клиента (TDD §12.1): HTTPS для getUserMedia в LAN и proxy сигналинга на сервер.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Сертификаты mkcert из `certs/` в корне репозитория (TDD §12.2); каталог в .gitignore. */
const CERT_PATH = fileURLToPath(new URL('../certs/cert.pem', import.meta.url));
const KEY_PATH = fileURLToPath(new URL('../certs/key.pem', import.meta.url));

/** В dev сервер слушает порт по умолчанию из §12.3 без env-префиксов: одинаково в Windows и Unix. */
const SERVER_ORIGIN = 'http://localhost:3000';

/**
 * Сертификаты, если они сгенерированы, иначе `undefined` — тогда Vite поднимает HTTP.
 * По `http://<LAN-IP>` браузер не даёт доступ к устройствам: клиент покажет «Откройте по HTTPS»
 * (`INSECURE_CONTEXT`, TDD §8.2). На `https://localhost` всё работает и без сертификатов.
 * @returns {{ key: Buffer, cert: Buffer } | undefined}
 */
function loadDevCertificates() {
  if (!existsSync(CERT_PATH) || !existsSync(KEY_PATH)) return undefined;
  return { key: readFileSync(KEY_PATH), cert: readFileSync(CERT_PATH) };
}

export default defineConfig({
  plugins: [react()],
  server: {
    // host: true — открыть dev-сервер другим устройствам LAN (TDD §12.1).
    host: true,
    https: loadDevCertificates(),
    proxy: {
      // ws: true — polling и WebSocket Socket.io идут по одному пути (TDD §6.2).
      '/socket.io': { target: SERVER_ORIGIN, ws: true },
    },
  },
});
