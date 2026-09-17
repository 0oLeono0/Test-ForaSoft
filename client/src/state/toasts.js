// Очередь коротких уведомлений (TDD §4.1.5): ссылка скопирована, нет доступа к устройству,
// устройство отключено, ошибка отправки сообщения.
//
// Хранилище вне React: toast поднимают и компоненты, и сервисы (`RoomSession`), а список действий
// reducer фиксирован (TDD §4.1.6). Компонент `Toasts` подписывается через `useSyncExternalStore`.

/** Сколько уведомление висит до автоскрытия. */
export const TOAST_TIMEOUT_MS = 5000;

/** Больше трёх подряд не показываем: самое старое уступает место новому. */
const MAX_VISIBLE = 3;

/** @typedef {{ id: number, text: string }} Toast */

/** @type {readonly Toast[]} */
let toasts = [];
/** @type {Set<() => void>} */
const listeners = new Set();
/** @type {Map<number, ReturnType<typeof setTimeout>>} */
const timers = new Map();
let lastId = 0;

function publish(next) {
  toasts = next;
  for (const listener of listeners) listener();
}

function cancelTimer(id) {
  const timer = timers.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  timers.delete(id);
}

/**
 * Показывает уведомление и скрывает его через `timeoutMs`.
 * @param {string} text
 * @param {{ timeoutMs?: number }} [options]
 * @returns {number} id — по нему уведомление можно снять раньше времени
 */
export function show(text, { timeoutMs = TOAST_TIMEOUT_MS } = {}) {
  lastId += 1;
  const id = lastId;
  const queued = [...toasts, { id, text }];
  const overflow = queued.slice(0, Math.max(queued.length - MAX_VISIBLE, 0));
  for (const toast of overflow) cancelTimer(toast.id);

  timers.set(
    id,
    setTimeout(() => dismiss(id), timeoutMs),
  );
  publish(queued.slice(-MAX_VISIBLE));
  return id;
}

/** @param {number} id */
export function dismiss(id) {
  cancelTimer(id);
  const next = toasts.filter((toast) => toast.id !== id);
  if (next.length !== toasts.length) publish(next);
}

/** Снимает все уведомления: при уходе с экрана комнаты и между тестами. */
export function clear() {
  for (const id of [...timers.keys()]) cancelTimer(id);
  if (toasts.length > 0) publish([]);
}

/**
 * @param {() => void} listener
 * @returns {() => void} отписка
 */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Один и тот же массив, пока очередь не изменилась — этого требует `useSyncExternalStore`. */
export function getSnapshot() {
  return toasts;
}
