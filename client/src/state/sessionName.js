// Имя участника на время одной загрузки SPA (TDD §5.4, FR-28).
//
// Хранится в переменной модуля: ни localStorage, ни sessionStorage, ни history.state (PRD §5).
// Поэтому перезагрузка страницы — это новый вход с повторным вводом имени, а переход
// с HomePage на /room/:roomId в рамках той же загрузки имя сохраняет (TDD §4.1.1).

/** @type {string | null} */
let name = null;

/** @returns {string | null} имя, если оно было введено на этой загрузке страницы */
export function get() {
  return name;
}

/** @param {string} value  нормализованное имя, прошедшее `validateName` */
export function set(value) {
  name = value;
}

/** Забыть имя: после выхода из комнаты и при `CONNECTION_LOST` («Войти заново», TDD §4.1.2). */
export function clear() {
  name = null;
}
