import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard.js';

const LINK = 'https://192.168.1.50:5173/room/V1StGXR8_Z';

/** В jsdom нет ни Clipboard API, ни execCommand: оба подставляются тестом. */
function stubClipboard(writeText) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

function stubExecCommand(implementation) {
  document.execCommand = implementation;
}

/** Значение поля в фокусе, выделенного целиком, — то, что реально попадёт в буфер. */
function selectedFieldValue() {
  const field = document.activeElement;
  if (!(field instanceof HTMLInputElement)) return null;
  return field.selectionStart === 0 && field.selectionEnd === field.value.length
    ? field.value
    : null;
}

afterEach(() => {
  delete navigator.clipboard;
  delete document.execCommand;
});

describe('copyText: Clipboard API', () => {
  it('копирует ссылку и не трогает DOM', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    stubExecCommand(vi.fn(() => true));

    await expect(copyText(LINK)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith(LINK);
    expect(document.execCommand).not.toHaveBeenCalled();
    expect(document.body.children).toHaveLength(0);
  });

  it('при отказе (нет разрешения, страница не в фокусе) пробует запасной способ', async () => {
    stubClipboard(vi.fn().mockRejectedValue(new DOMException('Denied', 'NotAllowedError')));
    stubExecCommand(vi.fn(() => selectedFieldValue() === LINK));

    await expect(copyText(LINK)).resolves.toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith('copy');
  });
});

describe('copyText: запасной способ через выделенное поле', () => {
  it('без Clipboard API копирует выделением', async () => {
    stubExecCommand(vi.fn(() => selectedFieldValue() === LINK));

    await expect(copyText(LINK)).resolves.toBe(true);
  });

  it('временное поле удаляется и при успехе, и при исключении', async () => {
    stubExecCommand(vi.fn(() => true));
    await copyText(LINK);
    expect(document.body.children).toHaveLength(0);

    stubExecCommand(
      vi.fn(() => {
        throw new Error('копирование недоступно');
      }),
    );
    await expect(copyText(LINK)).resolves.toBe(false);
    expect(document.body.children).toHaveLength(0);
  });

  it.each([
    ['execCommand вернул false', () => false],
    [
      'execCommand выбросил исключение',
      () => {
        throw new Error('bang');
      },
    ],
  ])('%s → false, вызывающий предложит скопировать вручную', async (_, implementation) => {
    stubExecCommand(vi.fn(implementation));

    await expect(copyText(LINK)).resolves.toBe(false);
  });

  it('без execCommand возвращает false, не выбрасывая исключение', async () => {
    await expect(copyText(LINK)).resolves.toBe(false);
  });
});
