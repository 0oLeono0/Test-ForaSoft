// Копирование ссылки-приглашения в буфер обмена (FR-3, US-3).

/**
 * Запасной способ для браузеров без Clipboard API и для случаев, когда доступ к нему запрещён
 * (например, страница не в фокусе): временное поле со ссылкой, выделение и `execCommand('copy')`.
 * Метод устарел, но остаётся единственным синхронным способом, работающим без разрешений.
 * @param {string} text
 * @returns {boolean}
 */
function copyBySelection(text) {
  if (typeof document.execCommand !== 'function') return false;

  const field = document.createElement('input');
  field.value = text;
  field.setAttribute('readonly', '');
  // Поле не должно быть видно и не должно прокручивать страницу к себе при фокусе.
  field.setAttribute('aria-hidden', 'true');
  field.style.position = 'fixed';
  field.style.top = '0';
  field.style.opacity = '0';
  document.body.append(field);

  try {
    // execCommand('copy') копирует выделение в фокусе, поэтому поле сначала получает фокус.
    field.focus();
    field.select();
    field.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

/**
 * Кладёт текст в буфер обмена. Ошибку не выбрасывает: вызывающий показывает toast «Ссылка
 * скопирована» или предлагает скопировать вручную (`CLIPBOARD_FAILED`, TDD §8.2).
 * @param {string} text
 * @returns {Promise<boolean>}  `true`, если хотя бы один из способов сработал
 */
export async function copyText(text) {
  if (typeof navigator.clipboard?.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard API доступен не всегда (нет разрешения, страница не в фокусе) — пробуем поле.
    }
  }
  return copyBySelection(text);
}
