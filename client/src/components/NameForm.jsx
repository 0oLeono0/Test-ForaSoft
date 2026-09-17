import {
  ERROR_CODES,
  ERROR_MESSAGES,
  NAME_ERROR_CODES,
  NAME_MAX_LENGTH,
  validateName,
} from '@vcr/shared';
import { useId, useState } from 'react';
import './NameForm.css';

/**
 * Подсказки под полем (TDD §4.1.5). `INVALID_NAME` приходит от сервера, остальные коды —
 * от `validateName` на клиенте; текст правил один и тот же (TDD §8.1).
 */
const NAME_HINTS = Object.freeze({
  [NAME_ERROR_CODES.NAME_EMPTY]: 'Введите имя',
  [NAME_ERROR_CODES.NAME_TOO_LONG]: `Имя не длиннее ${NAME_MAX_LENGTH} символов`,
  [NAME_ERROR_CODES.NAME_INVALID_CHARS]: ERROR_MESSAGES.INVALID_NAME,
  [ERROR_CODES.INVALID_NAME]: ERROR_MESSAGES.INVALID_NAME,
});

/**
 * Форма отображаемого имени (FR-1, FR-38, US-1). Проверяет имя теми же правилами, что и сервер,
 * и отдаёт наружу уже нормализованное значение.
 * @param {Object} props
 * @param {string} props.submitLabel  подпись кнопки: «Создать комнату» или «Войти»
 * @param {(name: string) => void} props.onSubmit  вызывается только с валидным именем
 * @param {boolean} [props.busy]  идёт вход: кнопка заблокирована от повторного клика (TDD §8.3)
 * @param {string|null} [props.error]  код ошибки от сервера, например `INVALID_NAME`
 */
export default function NameForm({ submitLabel, onSubmit, busy = false, error = null }) {
  const [name, setName] = useState('');
  const [localError, setLocalError] = useState(null);
  const fieldId = useId();
  const hintId = useId();

  const hint = NAME_HINTS[localError ?? error] ?? null;

  function handleSubmit(event) {
    event.preventDefault();
    if (busy) return;

    const result = validateName(name);
    if (!result.ok) {
      setLocalError(result.code);
      return;
    }
    setLocalError(null);
    onSubmit(result.value);
  }

  function handleChange(event) {
    setName(event.target.value);
    setLocalError(null);
  }

  return (
    <form className="name-form" onSubmit={handleSubmit} noValidate>
      <label className="name-form__label" htmlFor={fieldId}>
        Ваше имя
      </label>
      <input
        id={fieldId}
        className="name-form__input"
        type="text"
        value={name}
        onChange={handleChange}
        maxLength={NAME_MAX_LENGTH}
        autoComplete="off"
        aria-invalid={hint === null ? undefined : true}
        aria-describedby={hint === null ? undefined : hintId}
      />
      {/* Подсказка объявляется вслух: сабмит не перезагружает страницу (FR-1, US-1). */}
      {hint === null ? null : (
        <p className="name-form__hint" id={hintId} role="alert">
          {hint}
        </p>
      )}
      <button className="name-form__submit" type="submit" disabled={busy}>
        {submitLabel}
      </button>
    </form>
  );
}
