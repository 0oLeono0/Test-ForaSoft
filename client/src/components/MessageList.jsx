import { useAutoScroll } from '../hooks/useAutoScroll.js';
import { formatTime } from '../utils/formatTime.js';
import './MessageList.css';

/** Системные события комнаты в чате (FR-25, TDD §5.3). */
const SYSTEM_EVENT_TEXT = Object.freeze({
  joined: 'присоединился(-ась)',
  left: 'покинул(а) комнату',
});

/** @typedef {import('@vcr/shared').ChatMessage} ChatMessage */

/** @param {number} ts */
function isoTime(ts) {
  return Number.isFinite(ts) ? new Date(ts).toISOString() : undefined;
}

/**
 * Лента сообщений (FR-21, FR-22, FR-23, FR-25).
 *
 * Имя, текст и системное событие выводятся **только текстовыми узлами** JSX: HTML в сообщении
 * остаётся видимым текстом и не исполняется (FR-39, TDD §10.3).
 * @param {{ messages: ChatMessage[] }} props
 */
export default function MessageList({ messages }) {
  const listRef = useAutoScroll(messages.at(-1)?.id ?? null);

  if (messages.length === 0) {
    return (
      <div className="message-list message-list--empty" ref={listRef}>
        <p className="message-list__empty">Сообщений пока нет</p>
      </div>
    );
  }

  return (
    <ol className="message-list" ref={listRef} aria-label="Сообщения">
      {messages.map((message) =>
        message.type === 'system' ? (
          <li className="message message--system" key={message.id}>
            <span className="message__text">
              {`${message.subjectName} ${SYSTEM_EVENT_TEXT[message.event] ?? ''}`.trim()}
            </span>{' '}
            <time className="message__time" dateTime={isoTime(message.ts)}>
              {formatTime(message.ts)}
            </time>
          </li>
        ) : (
          <li className="message" key={message.id}>
            <p className="message__meta">
              <span className="message__author">{message.authorName}</span>
              <time className="message__time" dateTime={isoTime(message.ts)}>
                {formatTime(message.ts)}
              </time>
            </p>
            {/* white-space: pre-wrap — переводы строк сохраняются (TDD §4.1.5). */}
            <p className="message__text">{message.text}</p>
          </li>
        ),
      )}
    </ol>
  );
}
