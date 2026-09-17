import MessageInput from './MessageInput.jsx';
import MessageList from './MessageList.jsx';
import './ChatPanel.css';

/**
 * Чат в правой панели: лента и поле ввода (FR-21…FR-25, TDD §4.1.5).
 * @param {Object} props
 * @param {import('@vcr/shared').ChatMessage[]} props.messages
 * @param {(text: string) => boolean | Promise<boolean>} props.onSend
 * @param {number} [props.maxLength]  предел длины сообщения из ack `room:join`
 */
export default function ChatPanel({ messages, onSend, maxLength }) {
  return (
    <section className="chat-panel" aria-label="Чат">
      <h2 className="chat-panel__title">Чат</h2>
      <MessageList messages={messages} />
      <MessageInput onSend={onSend} maxLength={maxLength} />
    </section>
  );
}
