// Продуктовые константы, общие для клиента и сервера (TDD §4.3).

/** Участников в комнате одновременно (FR-7). */
export const MAX_PARTICIPANTS = 4;

/** Длина имени в code points (FR-38). */
export const NAME_MAX_LENGTH = 30;

/** Длина сообщения чата в code points (FR-40). */
export const MESSAGE_MAX_LENGTH = 1000;

/** Сообщений в истории одной комнаты на сервере (FR-23). */
export const CHAT_HISTORY_LIMIT = 200;

/** Буквы, цифры и незарезервированные символы URL, 1–64 code points; nanoid(10) — частный случай (TDD §14, Q-2). */
export const ROOM_ID_PATTERN = /^[\p{L}\p{N}._~-]{1,64}$/u;

/** Допустимый алфавит имени после нормализации: буквы, цифры, пробел, `.`, `_`, `-`. */
export const NAME_ALLOWED_CHARS = /^[\p{L}\p{N} ._-]+$/u;

/** В имени должна быть хотя бы одна буква или цифра (`"..."` недопустимо). */
export const NAME_HAS_ALNUM = /[\p{L}\p{N}]/u;
