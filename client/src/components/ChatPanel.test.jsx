import { MESSAGE_MAX_LENGTH } from '@vcr/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ChatPanel from './ChatPanel.jsx';

/** jsdom не считает раскладку: без подменённого scrollHeight прокрутка всегда 0. */
const SCROLL_HEIGHT = 900;

function userMessage(id, overrides = {}) {
  return {
    id,
    type: 'user',
    ts: Date.parse('2026-09-17T06:05:00.000Z'),
    authorId: 'p-1',
    authorName: 'Мария',
    text: `сообщение ${id}`,
    ...overrides,
  };
}

function systemMessage(id, event, subjectName) {
  return { id, type: 'system', ts: Date.parse('2026-09-17T06:07:00.000Z'), event, subjectName };
}

function setup({ messages = [], onSend = vi.fn(() => true), ...props } = {}) {
  const user = userEvent.setup();
  const view = render(<ChatPanel messages={messages} onSend={onSend} {...props} />);

  return {
    user,
    onSend,
    rerender: (next) => view.rerender(<ChatPanel messages={next} onSend={onSend} {...props} />),
    field: () => screen.getByLabelText('Сообщение'),
    submit: () => screen.getByRole('button', { name: 'Отправить' }),
  };
}

function stubScrollHeight() {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    value: SCROLL_HEIGHT,
  });
}

afterEach(() => {
  delete HTMLElement.prototype.scrollHeight;
});

describe('ChatPanel: лента', () => {
  it('показывает автора, время HH:MM и текст (FR-21, FR-22)', () => {
    setup({ messages: [userMessage('m1', { text: 'Всем привет' })] });

    const message = screen.getByRole('listitem');
    expect(within(message).getByText('Мария')).toBeInTheDocument();
    expect(within(message).getByText('09:05')).toBeInTheDocument();
    expect(within(message).getByText('Всем привет')).toBeInTheDocument();
  });

  it('системные сообщения о входе и выходе (FR-25, US-9)', () => {
    setup({
      messages: [systemMessage('s1', 'joined', 'Алекс'), systemMessage('s2', 'left', 'Пётр')],
    });

    expect(screen.getByText('Алекс присоединился(-ась)')).toBeInTheDocument();
    expect(screen.getByText('Пётр покинул(а) комнату')).toBeInTheDocument();
  });

  it('сохраняет порядок сообщений и историю до входа (FR-23)', () => {
    setup({
      messages: [
        userMessage('m1', { text: 'первое' }),
        systemMessage('s1', 'joined', 'Алекс'),
        userMessage('m2', { text: 'второе', authorName: 'Алекс' }),
      ],
    });

    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('list', { name: 'Сообщения' }).textContent).toMatch(
      /первое.*Алекс присоединился.*второе/s,
    );
  });

  it('пустая лента подсказывает, что сообщений нет', () => {
    setup();

    expect(screen.getByText('Сообщений пока нет')).toBeInTheDocument();
  });

  it('HTML в сообщении остаётся текстом (FR-39, US-8)', () => {
    const attack = '<img src=x onerror=alert(1)>';
    setup({ messages: [userMessage('m1', { text: attack, authorName: '<b>Мария</b>' })] });

    expect(screen.getByText(attack)).toBeInTheDocument();
    expect(screen.getByText('<b>Мария</b>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
  });

  it('переводы строк в сообщении сохраняются', () => {
    setup({ messages: [userMessage('m1', { text: 'первая\nвторая' })] });

    expect(screen.getByText(/первая/).textContent).toBe('первая\nвторая');
  });
});

describe('ChatPanel: автопрокрутка (US-8, FR-23)', () => {
  it('прокручивает ленту к последнему сообщению при открытии', () => {
    stubScrollHeight();
    setup({ messages: [userMessage('m1'), userMessage('m2')] });

    expect(screen.getByRole('list', { name: 'Сообщения' }).scrollTop).toBe(SCROLL_HEIGHT);
  });

  it.each([
    ['чужое', userMessage('m3', { authorName: 'Пётр' })],
    ['своё', userMessage('m3')],
    ['системное', systemMessage('s3', 'left', 'Пётр')],
  ])('%s сообщение прокручивает ленту, даже если её подняли вверх', (_, message) => {
    stubScrollHeight();
    const { rerender } = setup({ messages: [userMessage('m1'), userMessage('m2')] });

    // Пользователь читает историю: лента поднята выше последнего сообщения.
    const list = screen.getByRole('list', { name: 'Сообщения' });
    list.scrollTop = 120;

    rerender([userMessage('m1'), userMessage('m2'), message]);

    expect(screen.getByRole('list', { name: 'Сообщения' }).scrollTop).toBe(SCROLL_HEIGHT);
  });

  it('прокручивает и когда история упёрлась в предел: длина не растёт', () => {
    stubScrollHeight();
    const { rerender } = setup({ messages: [userMessage('m1'), userMessage('m2')] });

    screen.getByRole('list', { name: 'Сообщения' }).scrollTop = 120;
    // Самое старое сообщение вытеснено новым: сообщений столько же (CHAT_HISTORY_LIMIT).
    rerender([userMessage('m2'), userMessage('m3')]);

    expect(screen.getByRole('list', { name: 'Сообщения' }).scrollTop).toBe(SCROLL_HEIGHT);
  });

  it('перерисовка без нового сообщения ленту не трогает', () => {
    stubScrollHeight();
    const messages = [userMessage('m1'), userMessage('m2')];
    const { rerender } = setup({ messages });

    const list = screen.getByRole('list', { name: 'Сообщения' });
    list.scrollTop = 120;
    rerender([...messages]);

    expect(screen.getByRole('list', { name: 'Сообщения' }).scrollTop).toBe(120);
  });
});

describe('ChatPanel: отправка', () => {
  it('отправляет текст и очищает поле', async () => {
    const { user, onSend, field, submit } = setup();

    await user.type(field(), 'Всем привет');
    await user.click(submit());

    expect(onSend).toHaveBeenCalledExactlyOnceWith('Всем привет');
    expect(field()).toHaveValue('');
  });

  it('Enter отправляет, Shift+Enter переносит строку (US-8)', async () => {
    const { user, onSend, field } = setup();

    await user.type(field(), 'первая{Shift>}{Enter}{/Shift}вторая');
    expect(onSend).not.toHaveBeenCalled();
    expect(field()).toHaveValue('первая\nвторая');

    await user.type(field(), '{Enter}');
    expect(onSend).toHaveBeenCalledExactlyOnceWith('первая\nвторая');
  });

  it.each([
    ['пустое', ''],
    ['из пробелов', '   '],
    ['из переводов строк', '{Shift>}{Enter}{Enter}{/Shift}'],
  ])('%s сообщение не отправляется (FR-24)', async (_, value) => {
    const { user, onSend, field, submit } = setup();

    if (value !== '') await user.type(field(), value);

    expect(submit()).toBeDisabled();
    await user.type(field(), '{Enter}');

    expect(onSend).not.toHaveBeenCalled();
  });

  it('при ошибке ack текст остаётся в поле (TDD §8.1)', async () => {
    const onSend = vi.fn(() => false);
    const { user, field, submit } = setup({ onSend });

    await user.type(field(), 'Слишком часто');
    await user.click(submit());

    expect(onSend).toHaveBeenCalledOnce();
    expect(field()).toHaveValue('Слишком часто');
  });

  it('исключение при отправке не ломает поле', async () => {
    const onSend = vi.fn(() => Promise.reject(new Error('нет сети')));
    const { user, field, submit } = setup({ onSend });

    await user.type(field(), 'Всем привет');
    await user.click(submit());

    expect(field()).toHaveValue('Всем привет');
    expect(submit()).toBeEnabled();
  });

  it('пока сообщение отправляется, второй раз оно не уходит', async () => {
    let resolveSend;
    const onSend = vi.fn(() => new Promise((resolve) => (resolveSend = resolve)));
    const { user, field, submit } = setup({ onSend });

    await user.type(field(), 'Всем привет');
    await user.click(submit());

    expect(submit()).toBeDisabled();
    await user.type(field(), '{Enter}');
    expect(onSend).toHaveBeenCalledOnce();

    resolveSend(true);
  });
});

describe('ChatPanel: длина сообщения', () => {
  it('поле ограничено пределом по умолчанию и показывает счётчик (FR-40)', async () => {
    const { user, field } = setup();

    expect(field()).toHaveAttribute('maxLength', String(MESSAGE_MAX_LENGTH));
    expect(screen.getByText(`0/${MESSAGE_MAX_LENGTH}`)).toBeInTheDocument();

    await user.type(field(), 'Привет');
    expect(screen.getByText(`6/${MESSAGE_MAX_LENGTH}`)).toBeInTheDocument();
  });

  it('предел берётся из limits ack room:join (TDD §6.3)', () => {
    setup({ maxLength: 140 });

    expect(screen.getByLabelText('Сообщение')).toHaveAttribute('maxLength', '140');
    expect(screen.getByText('0/140')).toBeInTheDocument();
  });

  it('счётчик считает символы, а не суррогатные пары', async () => {
    const { user, field } = setup({ maxLength: 10 });

    await user.type(field(), '👋👋');

    expect(screen.getByText('2/10')).toBeInTheDocument();
  });
});
