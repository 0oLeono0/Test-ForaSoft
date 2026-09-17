import { describe, expect, it } from 'vitest';
import { NAME_ERROR_CODES, normalizeName, validateName } from './validation.js';

const { NAME_EMPTY, NAME_TOO_LONG, NAME_INVALID_CHARS } = NAME_ERROR_CODES;

// «ё» из двух code points: «е» (U+0435) + комбинируемая диерезис (U+0308).
const DECOMPOSED_YO = 'е\u0308';
// Математическая «A» вне BMP: одна буква, но две UTF-16 единицы.
const ASTRAL_LETTER = '\u{1D400}';

describe('NAME_ERROR_CODES', () => {
  it('содержит три кода из TDD §4.3, ключ совпадает со значением', () => {
    expect(NAME_ERROR_CODES).toEqual({
      NAME_EMPTY: 'NAME_EMPTY',
      NAME_TOO_LONG: 'NAME_TOO_LONG',
      NAME_INVALID_CHARS: 'NAME_INVALID_CHARS',
    });
    expect(Object.isFrozen(NAME_ERROR_CODES)).toBe(true);
  });
});

describe('normalizeName', () => {
  it('обрезает пробелы по краям', () => {
    expect(normalizeName('  Алекс  ')).toBe('Алекс');
  });

  it('схлопывает повторные пробелы внутри', () => {
    expect(normalizeName('Алекс    Иванов')).toBe('Алекс Иванов');
  });

  it('заменяет табуляцию, перевод строки и неразрывный пробел одним обычным пробелом', () => {
    expect(normalizeName('\tАлекс\t\n\u00A0Иванов\n')).toBe('Алекс Иванов');
  });

  it('приводит к NFC: разложенная «ё» становится одним символом', () => {
    expect(normalizeName(`П${DECOMPOSED_YO}тр`)).toBe('Пётр');
  });

  it('не удаляет недопустимые символы — их отклоняет validateName', () => {
    expect(normalizeName(' <b>Алекс</b> ')).toBe('<b>Алекс</b>');
  });
});

describe('validateName: пустое имя', () => {
  it.each([
    ['пустая строка', ''],
    ['только пробелы', '     '],
    ['пробельные символы разных видов', '\t\n\u00A0 '],
  ])('%s → NAME_EMPTY', (_label, raw) => {
    expect(validateName(raw)).toEqual({ ok: false, code: NAME_EMPTY });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['число', 42],
    ['объект', { name: 'Алекс' }],
    ['массив', ['Алекс']],
  ])('не-строка (%s) → NAME_EMPTY', (_label, raw) => {
    expect(validateName(raw)).toEqual({ ok: false, code: NAME_EMPTY });
  });
});

describe('validateName: длина в code points', () => {
  it('ровно 30 символов — ok', () => {
    expect(validateName('а'.repeat(30))).toEqual({ ok: true, value: 'а'.repeat(30) });
  });

  it('31 символ → NAME_TOO_LONG', () => {
    expect(validateName('а'.repeat(31))).toEqual({ ok: false, code: NAME_TOO_LONG });
  });

  it('длина считается после обрезки и схлопывания пробелов', () => {
    const raw = `   ${'a'.repeat(15)}     ${'b'.repeat(14)}   `;
    expect(validateName(raw)).toEqual({ ok: true, value: `${'a'.repeat(15)} ${'b'.repeat(14)}` });
  });

  it('символ вне BMP считается одним: 30 таких букв — ok, 31 → NAME_TOO_LONG', () => {
    expect(validateName(ASTRAL_LETTER.repeat(30))).toMatchObject({ ok: true });
    expect(validateName(ASTRAL_LETTER.repeat(31))).toEqual({ ok: false, code: NAME_TOO_LONG });
  });

  it('длина считается после NFC: 30 разложенных «ё» (60 code points) — ok', () => {
    expect(validateName(DECOMPOSED_YO.repeat(30))).toEqual({ ok: true, value: 'ё'.repeat(30) });
  });
});

describe('validateName: допустимые имена', () => {
  it.each([
    ['кириллица', 'Алекс'],
    ['ё и Ё', 'Ёжик Пётр'],
    ['латиница', 'Alex'],
    ['буквы с диакритикой', 'Zoë Müller'],
    ['только цифры', '42'],
    ['буквы и цифры с пробелом', 'Agent 007'],
    ['дефис, подчёркивание и точка', 'jean-luc_picard.2'],
    ['знаки по краям при наличии буквы', '.Алекс-'],
  ])('%s: %s', (_label, raw) => {
    expect(validateName(raw)).toEqual({ ok: true, value: raw });
  });

  it('возвращает нормализованное значение', () => {
    expect(validateName(`  Алекс   П${DECOMPOSED_YO}тр `)).toEqual({
      ok: true,
      value: 'Алекс Пётр',
    });
  });
});

describe('validateName: недопустимые символы', () => {
  it.each([
    ['только точки', '...'],
    ['только разрешённые знаки', '-_.'],
    ['эмодзи', 'Алекс 😀'],
    ['эмодзи без букв', '😀'],
    ['<script>', '<script>alert(1)</script>'],
    ['HTML-тег', '<b>Алекс</b>'],
    ['одинарная кавычка', "O'Brien"],
    ['двойные кавычки', 'Алекс "Босс"'],
    ['слэш', 'a/b'],
    ['обратный слэш', 'a\\b'],
    ['амперсанд', 'Tom & Jerry'],
    ['zero-width space внутри', 'Алекс\u200BИванов'],
    ['только zero-width space', '\u200B'],
    ['комбинируемый знак без составной формы', 'q\u0301'],
    ['«zalgo»: цепочка комбинируемых знаков', 'Z\u0351\u0360\u0489'],
    ['bidi-override', 'Алекс\u202Eнави'],
    ['управляющий символ', 'Алекс\u0000'],
  ])('%s → NAME_INVALID_CHARS', (_label, raw) => {
    expect(validateName(raw)).toEqual({ ok: false, code: NAME_INVALID_CHARS });
  });
});
