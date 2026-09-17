import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from './errors.js';
import {
  isValidRoomId,
  NAME_ERROR_CODES,
  normalizeMessage,
  normalizeName,
  validateMessage,
  validateName,
} from './validation.js';

const { NAME_EMPTY, NAME_TOO_LONG, NAME_INVALID_CHARS } = NAME_ERROR_CODES;
const { MESSAGE_EMPTY, MESSAGE_TOO_LONG } = ERROR_CODES;

// urlAlphabet пакета nanoid: из этих 64 символов состоит nanoid(10).
const NANOID_ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';

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

describe('normalizeMessage', () => {
  it('обрезает пробелы и переводы строк по краям', () => {
    expect(normalizeMessage(' \n\t привет \r\n ')).toBe('привет');
  });

  it('сохраняет переводы строк и пробелы внутри', () => {
    expect(normalizeMessage('строка 1\n\n  строка 2')).toBe('строка 1\n\n  строка 2');
  });

  it('удаляет возврат каретки: CRLF становится LF', () => {
    expect(normalizeMessage('a\r\nb')).toBe('a\nb');
  });

  it.each([
    ['NUL', '\u0000'],
    ['BEL', '\u0007'],
    ['табуляция', '\t'],
    ['ESC', '\u001B'],
    ['DEL', '\u007F'],
    ['NEL', '\u0085'],
    ['APC', '\u009F'],
  ])('удаляет управляющий символ %s', (_label, ch) => {
    expect(normalizeMessage(`a${ch}b`)).toBe('ab');
  });

  it.each(
    ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069'].map(
      (ch) => [ch.codePointAt(0).toString(16).toUpperCase(), ch],
    ),
  )('удаляет символ управления направлением U+%s', (_code, ch) => {
    expect(normalizeMessage(`a${ch}b`)).toBe('ab');
  });

  it('bidi-override не может развернуть часть текста', () => {
    expect(normalizeMessage('invoice_\u202Efdp.exe')).toBe('invoice_fdp.exe');
  });

  it('удаляет управляющие символы до обрезки краёв', () => {
    expect(normalizeMessage('\u0000  привет  \u202E')).toBe('привет');
  });

  it('не изменяет HTML — экранирование выполняется при выводе', () => {
    expect(normalizeMessage('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });
});

describe('validateMessage: пустое сообщение', () => {
  it.each([
    ['пустая строка', ''],
    ['только пробелы', '     '],
    ['только переводы строк', '\n\n\n'],
    ['пробельные символы разных видов', ' \t\r\n\u00A0 '],
    ['только управляющие и bidi-символы', '\u0000\u0007\u202E\u2066'],
  ])('%s → MESSAGE_EMPTY', (_label, raw) => {
    expect(validateMessage(raw)).toEqual({ ok: false, code: MESSAGE_EMPTY });
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['число', 42],
    ['объект', { text: 'привет' }],
    ['массив', ['привет']],
  ])('не-строка (%s) → MESSAGE_EMPTY', (_label, raw) => {
    expect(validateMessage(raw)).toEqual({ ok: false, code: MESSAGE_EMPTY });
  });
});

describe('validateMessage: длина в code points', () => {
  it('ровно 1000 символов — ok', () => {
    expect(validateMessage('x'.repeat(1000))).toEqual({ ok: true, value: 'x'.repeat(1000) });
  });

  it('1001 символ → MESSAGE_TOO_LONG', () => {
    expect(validateMessage('x'.repeat(1001))).toEqual({ ok: false, code: MESSAGE_TOO_LONG });
  });

  it('длина считается после нормализации', () => {
    const raw = `\n  ${'x'.repeat(1000)}\u0000\u202E  \n`;
    expect(validateMessage(raw)).toEqual({ ok: true, value: 'x'.repeat(1000) });
  });

  it('переводы строк внутри считаются символами', () => {
    expect(validateMessage(`${'x\n'.repeat(500)}x`)).toEqual({ ok: false, code: MESSAGE_TOO_LONG });
  });

  it('эмодзи вне BMP считается одним символом: 1000 — ok, 1001 → MESSAGE_TOO_LONG', () => {
    expect(validateMessage('😀'.repeat(1000))).toMatchObject({ ok: true });
    expect(validateMessage('😀'.repeat(1001))).toEqual({ ok: false, code: MESSAGE_TOO_LONG });
  });
});

describe('validateMessage: допустимое сообщение', () => {
  it('возвращает нормализованный текст', () => {
    expect(validateMessage('  Привет!\r\nКак дела? 😀 <b>ok</b>\n')).toEqual({
      ok: true,
      value: 'Привет!\nКак дела? 😀 <b>ok</b>',
    });
  });
});

describe('isValidRoomId', () => {
  it.each([
    ['1 символ', 'a'],
    ['64 символа', 'a'.repeat(64)],
    ['64 буквы вне BMP — длина в code points', ASTRAL_LETTER.repeat(64)],
    ['пример nanoid(10) из TDD §6.5', 'V1StGXR8_Z'],
    ['весь алфавит nanoid', NANOID_ALPHABET],
    ['кириллица', 'комната-42'],
    ['незарезервированные символы URL', 'a.b_c~d-e'],
  ])('%s → true', (_label, id) => {
    expect(isValidRoomId(id)).toBe(true);
  });

  it.each([
    ['пустая строка', ''],
    ['65 символов', 'a'.repeat(65)],
    ['слэш', 'a/b'],
    ['выход из каталога', '../x'],
    ['HTML-тег', '<b>'],
    ['пробел', 'a b'],
    ['процент', '%20'],
    ['знак вопроса', 'a?b'],
    ['решётка', 'a#b'],
    ['перевод строки в конце', 'abc\n'],
    ['zero-width space', 'abc\u200B'],
    ['эмодзи', 'комната😀'],
  ])('%s → false', (_label, id) => {
    expect(isValidRoomId(id)).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['число', 1234567890],
    ['объект', {}],
    ['массив, который приводится к валидной строке', ['abc123']],
  ])('не-строка (%s) → false', (_label, id) => {
    expect(isValidRoomId(id)).toBe(false);
  });
});
