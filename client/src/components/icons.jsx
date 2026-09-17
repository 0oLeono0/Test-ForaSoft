// Иконки состояния устройств и заглушка без видео (FR-16, FR-18).
//
// Инлайн-SVG, а не шрифт или картинка: CSP запрещает сторонние источники (TDD §10.3), а цвет
// берётся из `currentColor`. С `title` иконка становится доступной для скринридера, без него —
// декоративной: подпись даёт соседний текст.

/** @param {{ title?: string }} props */
function iconProps({ title }) {
  return {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    focusable: 'false',
    ...(title === undefined ? { 'aria-hidden': 'true' } : { role: 'img', 'aria-label': title }),
  };
}

/** Микрофон включён. */
export function MicIcon(props) {
  return (
    <svg {...iconProps(props)}>
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v4" />
    </svg>
  );
}

/** Микрофон выключен: перечёркнут (FR-16). */
export function MicOffIcon(props) {
  return (
    <svg {...iconProps(props)}>
      <rect x="9" y="2" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v4" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

/** Камера включена. */
export function CameraIcon(props) {
  return (
    <svg {...iconProps(props)}>
      <rect x="2" y="6" width="13" height="12" rx="2" />
      <path d="M15 11l7-4v10l-7-4z" />
    </svg>
  );
}

/** Камера выключена: перечёркнута. */
export function CameraOffIcon(props) {
  return (
    <svg {...iconProps(props)}>
      <rect x="2" y="6" width="13" height="12" rx="2" />
      <path d="M15 11l7-4v10l-7-4z" />
      <path d="M3 3l18 18" />
    </svg>
  );
}

/** Силуэт человека вместо видео (FR-18). */
export function PersonIcon(props) {
  return (
    <svg {...iconProps(props)} width={48} height={48}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </svg>
  );
}
