// Время сообщения чата (FR-22).

/**
 * Часы и минуты в локальной зоне браузера: сервер присылает epoch ms, формат HH:MM одинаков
 * для всех сообщений ленты.
 */
const TIME_FORMAT = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

/**
 * @param {number} ts  epoch ms (часы сервера, TDD §5.2)
 * @returns {string}  например `09:05`; пустая строка, если времени нет — лента не должна падать
 *   из-за одного сообщения
 */
export function formatTime(ts) {
  if (!Number.isFinite(ts)) return '';
  return TIME_FORMAT.format(new Date(ts));
}
