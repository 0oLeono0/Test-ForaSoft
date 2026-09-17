import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOAST_TIMEOUT_MS, clear, dismiss, getSnapshot, show, subscribe } from './toasts.js';

function texts() {
  return getSnapshot().map((toast) => toast.text);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  clear();
  vi.useRealTimers();
});

describe('toasts: очередь', () => {
  it('пустая до первого уведомления', () => {
    expect(getSnapshot()).toEqual([]);
  });

  it('новые уведомления идут в конец очереди', () => {
    show('Ссылка скопирована');
    show('Устройство отключено');

    expect(texts()).toEqual(['Ссылка скопирована', 'Устройство отключено']);
  });

  it('у каждого уведомления свой id', () => {
    const first = show('Первое');
    const second = show('Второе');

    expect(first).not.toBe(second);
    expect(getSnapshot().map((toast) => toast.id)).toEqual([first, second]);
  });

  it('больше трёх не копится: самое старое уходит', () => {
    for (const text of ['1', '2', '3', '4']) show(text);

    expect(texts()).toEqual(['2', '3', '4']);
  });
});

describe('toasts: автоскрытие', () => {
  it('уведомление исчезает через TOAST_TIMEOUT_MS', () => {
    show('Ссылка скопирована');

    vi.advanceTimersByTime(TOAST_TIMEOUT_MS - 1);
    expect(texts()).toEqual(['Ссылка скопирована']);

    vi.advanceTimersByTime(1);
    expect(texts()).toEqual([]);
  });

  it('у каждого уведомления свой отсчёт', () => {
    show('Первое');
    vi.advanceTimersByTime(TOAST_TIMEOUT_MS / 2);
    show('Второе');

    vi.advanceTimersByTime(TOAST_TIMEOUT_MS / 2);
    expect(texts()).toEqual(['Второе']);

    vi.advanceTimersByTime(TOAST_TIMEOUT_MS / 2);
    expect(texts()).toEqual([]);
  });

  it('время показа можно задать', () => {
    show('Быстрое', { timeoutMs: 100 });

    vi.advanceTimersByTime(100);
    expect(texts()).toEqual([]);
  });

  it('вытесненное уведомление не снимает чужое по таймеру', () => {
    show('1', { timeoutMs: 100 });
    for (const text of ['2', '3', '4']) show(text);

    vi.advanceTimersByTime(100);
    expect(texts()).toEqual(['2', '3', '4']);
  });
});

describe('toasts: снятие вручную', () => {
  it('dismiss убирает только своё уведомление', () => {
    const first = show('Первое');
    show('Второе');

    dismiss(first);

    expect(texts()).toEqual(['Второе']);
  });

  it('повторный dismiss и неизвестный id ничего не делают', () => {
    const id = show('Первое');
    dismiss(id);
    const before = getSnapshot();

    dismiss(id);
    dismiss(-1);

    expect(getSnapshot()).toBe(before);
  });

  it('clear снимает все уведомления и их таймеры', () => {
    show('Первое');
    show('Второе');

    clear();

    expect(texts()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('toasts: подписка', () => {
  it('слушатель получает каждое изменение очереди', () => {
    const listener = vi.fn();
    subscribe(listener);

    const id = show('Первое');
    expect(listener).toHaveBeenCalledOnce();

    dismiss(id);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('снимок не меняется, пока очередь не изменилась', () => {
    const before = getSnapshot();
    dismiss(-1);

    expect(getSnapshot()).toBe(before);
  });

  it('после отписки уведомления не приходят', () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    unsubscribe();
    show('Первое');

    expect(listener).not.toHaveBeenCalled();
  });
});
