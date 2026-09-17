import { useEffect, useRef } from 'react';

/**
 * Привязывает поток к `<video>`: `srcObject`, запуск воспроизведения и очистка (TDD §4.1.5).
 *
 * `autoPlay` в разметке не всегда срабатывает: браузер может отклонить запуск со звуком до жеста
 * пользователя. Тогда `play()` отклоняется с `NotAllowedError`, и об этом нужно сообщить, чтобы
 * показать баннер «Включить звук» (FR-37, TDD §8.2). Остальные отказы — обычно `AbortError` от
 * смены потока — игнорируются.
 * @param {MediaStream|null} [stream]
 * @param {() => void} [onAutoplayBlocked]
 * @returns {import('react').RefObject<HTMLMediaElement>}
 */
export function useMediaElement(stream = null, onAutoplayBlocked) {
  const ref = useRef(null);
  const blockedHandler = useRef(onAutoplayBlocked);

  // Колбэк меняется при каждом рендере родителя, а перепривязывать поток из-за этого не нужно.
  useEffect(() => {
    blockedHandler.current = onAutoplayBlocked;
  });

  useEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;

    element.srcObject = stream;
    let released = false;

    if (stream !== null) {
      // play() возвращает промис не во всех средах (jsdom, старые браузеры).
      Promise.resolve(element.play?.()).catch((error) => {
        if (released || error?.name !== 'NotAllowedError') return;
        blockedHandler.current?.();
      });
    }

    return () => {
      released = true;
      // Отвязываем поток: иначе элемент держит дорожки после размонтирования плитки.
      element.srcObject = null;
    };
  }, [stream]);

  return ref;
}
