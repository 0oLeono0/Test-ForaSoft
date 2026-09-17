import { useLayoutEffect, useRef } from 'react';

/**
 * Держит ленту прокрученной к последнему элементу (FR-23, US-8).
 *
 * Прокрутка происходит при каждом новом сообщении — своём, чужом и системном, — даже если
 * пользователь читал историю выше. Вариант «не мешать чтению» отклонён в TDD §7.5 и §14 (Q-6):
 * он противоречит критерию приёмки US-8.
 * @param {unknown} lastKey  идентификатор последнего элемента: длина не годится, потому что
 *   история ограничена CHAT_HISTORY_LIMIT и перестаёт расти
 * @returns {import('react').RefObject<HTMLElement>}  ref на прокручиваемый контейнер
 */
export function useAutoScroll(lastKey) {
  const ref = useRef(null);

  // useLayoutEffect — прокрутка до отрисовки кадра, иначе видно рывок.
  useLayoutEffect(() => {
    const node = ref.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [lastKey]);

  return ref;
}
