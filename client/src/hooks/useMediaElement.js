import { useEffect, useRef } from 'react';

/**
 * Живые медиаэлементы плиток. Баннер «Включить звук» запускает их все разом: жест пользователя
 * снимает autoplay-блокировку сразу для всей страницы (FR-37, TDD §4.1.5).
 * @type {Set<HTMLMediaElement>}
 */
const mediaElements = new Set();

/**
 * Повторный `play()` для всех плиток после клика по баннеру (FR-37).
 * @returns {Promise<void>}
 */
export async function unlockMediaElements() {
  await Promise.all(
    [...mediaElements].map((element) =>
      // Плитка могла остаться без потока — такой `play()` отклоняется, и это не ошибка.
      Promise.resolve(element.play?.()).catch(() => {}),
    ),
  );
}

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

    mediaElements.add(element);
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
      mediaElements.delete(element);
      // Отвязываем поток: иначе элемент держит дорожки после размонтирования плитки.
      element.srcObject = null;
    };
  }, [stream]);

  return ref;
}
