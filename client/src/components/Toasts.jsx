import { useSyncExternalStore } from 'react';
import { dismiss, getSnapshot, subscribe } from '../state/toasts.js';
import './Toasts.css';

/**
 * Очередь коротких уведомлений (FR-3, FR-20, FR-33). Собственных props нет: очередь живёт
 * в `state/toasts.js`, поэтому уведомление может поднять и компонент, и сервис.
 */
export default function Toasts() {
  const toasts = useSyncExternalStore(subscribe, getSnapshot);

  return (
    // role="status" — вежливая живая область: новые уведомления зачитываются, не перебивая (TDD §4.1.5).
    <div className="toasts" role="status">
      <ul className="toasts__list">
        {toasts.map((toast) => (
          <li className="toasts__item" key={toast.id}>
            <span className="toasts__text">{toast.text}</span>
            <button
              className="toasts__close"
              type="button"
              aria-label="Скрыть уведомление"
              onClick={() => dismiss(toast.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
