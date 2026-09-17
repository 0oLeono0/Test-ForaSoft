import { ERROR_CODES, NAME_MAX_LENGTH } from '@vcr/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import NameForm from './NameForm.jsx';

function setup(props = {}) {
  const onSubmit = vi.fn();
  const user = userEvent.setup();
  render(<NameForm submitLabel="Войти" onSubmit={onSubmit} {...props} />);

  return {
    user,
    onSubmit,
    field: screen.getByLabelText('Ваше имя'),
    submit: screen.getByRole('button', { name: 'Войти' }),
  };
}

describe('NameForm: валидное имя', () => {
  it('отдаёт нормализованное имя: лишние пробелы схлопываются', async () => {
    const { user, onSubmit, field, submit } = setup();

    await user.type(field, '   Алекс   Петров  ');
    await user.click(submit);

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('Алекс Петров');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('отправляется по Enter (US-1)', async () => {
    const { user, onSubmit, field } = setup();

    await user.type(field, 'Мария{Enter}');

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith('Мария');
  });

  it('поле ограничено 30 символами (FR-38)', async () => {
    const { user, onSubmit, field, submit } = setup();

    expect(field).toHaveAttribute('maxLength', String(NAME_MAX_LENGTH));

    await user.type(field, 'а'.repeat(NAME_MAX_LENGTH + 5));
    expect(field).toHaveValue('а'.repeat(NAME_MAX_LENGTH));

    await user.click(submit);
    expect(onSubmit).toHaveBeenCalledWith('а'.repeat(NAME_MAX_LENGTH));
  });
});

describe('NameForm: подсказки', () => {
  it.each([
    ['пустое имя', '', 'Введите имя'],
    ['одни пробелы', '    ', 'Введите имя'],
    ['недопустимые символы', '<script>', 'Имя может содержать буквы'],
    ['имя без букв и цифр', '...', 'Имя может содержать буквы'],
  ])('%s: подсказка под полем, вход не начинается', async (_, value, hint) => {
    const { user, onSubmit, field, submit } = setup();

    if (value !== '') await user.type(field, value);
    await user.click(submit);

    expect(screen.getByRole('alert')).toHaveTextContent(hint);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(expect.stringContaining(hint));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('подсказка исчезает, как только пользователь правит имя', async () => {
    const { user, field, submit } = setup();

    await user.click(submit);
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await user.type(field, 'А');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(field).not.toHaveAttribute('aria-invalid');
  });

  it('показывает INVALID_NAME от сервера (TDD §8.1)', () => {
    setup({ error: ERROR_CODES.INVALID_NAME });

    expect(screen.getByRole('alert')).toHaveTextContent('Имя может содержать буквы');
  });

  it('неизвестный код ошибки подсказку не рисует', () => {
    setup({ error: ERROR_CODES.INTERNAL_ERROR });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('NameForm: busy', () => {
  it('кнопка заблокирована и повторный вход не начинается (TDD §8.3)', async () => {
    const { user, onSubmit, field, submit } = setup({ busy: true });

    await user.type(field, 'Алекс');
    expect(submit).toBeDisabled();

    await user.click(submit);
    await user.type(field, '{Enter}');

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
