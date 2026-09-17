import { MESSAGE_MAX_LENGTH, validateMessage } from '@vcr/shared';
import { useId, useState } from 'react';
import './MessageInput.css';

/** Длина в code points — так же считает сервер (TDD §4.3). */
function codePointLength(text) {
  return [...text].length;
}

/**
 * Поле ввода сообщения (FR-21, FR-24, US-8).
 * @param {Object} props
 * @param {(text: string) => boolean | Promise<boolean>} props.onSend  `false` — сообщение не
 *   доставлено (ошибка ack): текст остаётся в поле, чтобы его не пришлось набирать заново
 * @param {number} [props.maxLength]  из `limits.messageMaxLength` в ack `room:join` (TDD §6.3)
 */
export default function MessageInput({ onSend, maxLength = MESSAGE_MAX_LENGTH }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const counterId = useId();

  // Те же правила, что на сервере: пустое сообщение и сообщение из пробелов не отправляются (FR-24).
  const validation = validateMessage(text);
  const canSend = validation.ok && !sending;

  async function send() {
    if (!canSend) return;

    setSending(true);
    try {
      // Ошибку показывает вызывающий (toast, TDD §8.1) — поле лишь сохраняет текст.
      const delivered = await onSend(validation.value);
      if (delivered !== false) setText('');
    } catch {
      // Текст остаётся в поле.
    } finally {
      setSending(false);
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    send();
  }

  function handleKeyDown(event) {
    // Enter — отправить, Shift+Enter — перенос строки (US-8).
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    send();
  }

  return (
    <form className="message-input" onSubmit={handleSubmit}>
      <textarea
        className="message-input__field"
        aria-label="Сообщение"
        aria-describedby={counterId}
        rows={2}
        maxLength={maxLength}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="message-input__footer">
        <span className="message-input__counter" id={counterId}>
          {codePointLength(text)}/{maxLength}
        </span>
        <button className="message-input__submit" type="submit" disabled={!canSend}>
          Отправить
        </button>
      </div>
    </form>
  );
}
