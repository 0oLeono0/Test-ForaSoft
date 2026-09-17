import './RoomLayout.css';

/**
 * Раскладка экрана комнаты (TDD §4.1.5): область сетки, панель управления под ней и правая
 * панель фиксированной ширины. Собственного состояния нет — содержимое передаётся слотами.
 * @param {Object} props
 * @param {import('react').ReactNode} props.children  сетка видеоплиток
 * @param {import('react').ReactNode} [props.controls]  панель управления под сеткой
 * @param {import('react').ReactNode} [props.sidebar]  правая панель: участники и чат
 */
export default function RoomLayout({ children, controls, sidebar }) {
  return (
    <div className="room-layout">
      <div className="room-layout__main">
        <main className="room-layout__stage">{children}</main>
        {controls ? <div className="room-layout__controls">{controls}</div> : null}
      </div>
      <aside className="room-layout__sidebar" aria-label="Участники и чат">
        {sidebar}
      </aside>
    </div>
  );
}
