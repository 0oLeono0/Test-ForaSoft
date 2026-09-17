// Раскладка видеосетки (FR-11, TDD §4.1.5).
import { MAX_PARTICIPANTS } from '@vcr/shared';

/** Колонки × ряды для 1, 2, 3 и 4 плиток; при трёх участниках четвёртая ячейка пустая. */
const LAYOUTS = Object.freeze([
  Object.freeze({ columns: 1, rows: 1 }),
  Object.freeze({ columns: 2, rows: 1 }),
  Object.freeze({ columns: 2, rows: 2 }),
  Object.freeze({ columns: 2, rows: 2 }),
]);

/**
 * @param {number} count  число плиток вместе с собственной; за пределами 1…4 значение
 *   ограничивается: сетка никогда не бывает пустой, а больше 4 участников не бывает (FR-7)
 * @returns {{ columns: number, rows: number }}
 */
export function gridLayout(count) {
  const tiles = Number.isFinite(count) ? Math.trunc(count) : 1;
  return LAYOUTS[Math.min(Math.max(tiles, 1), MAX_PARTICIPANTS) - 1];
}
