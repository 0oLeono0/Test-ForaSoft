import { describe, expect, it } from 'vitest';
import { gridLayout } from './gridLayout.js';

describe('gridLayout', () => {
  it.each([
    [1, { columns: 1, rows: 1 }],
    [2, { columns: 2, rows: 1 }],
    [3, { columns: 2, rows: 2 }],
    [4, { columns: 2, rows: 2 }],
  ])('%i плиток → %o', (count, expected) => {
    expect(gridLayout(count)).toEqual(expected);
  });

  it.each([0, -1, NaN, undefined])('%s даёт раскладку одной плитки', (count) => {
    expect(gridLayout(count)).toEqual({ columns: 1, rows: 1 });
  });

  it('больше четырёх плиток не бывает: раскладка остаётся 2×2', () => {
    expect(gridLayout(5)).toEqual({ columns: 2, rows: 2 });
  });
});
