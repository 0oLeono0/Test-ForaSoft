import { afterEach, describe, expect, it } from 'vitest';
import * as sessionName from './sessionName.js';

afterEach(() => {
  sessionName.clear();
});

describe('sessionName', () => {
  it('до ввода имени пусто', () => {
    expect(sessionName.get()).toBeNull();
  });

  it('set сохраняет имя, clear забывает его', () => {
    sessionName.set('Алекс');
    expect(sessionName.get()).toBe('Алекс');

    sessionName.set('Мария');
    expect(sessionName.get()).toBe('Мария');

    sessionName.clear();
    expect(sessionName.get()).toBeNull();
  });

  it('ничего не сохраняет в браузере: перезагрузка — новый вход (FR-28)', () => {
    sessionName.set('Алекс');

    expect({ ...localStorage }).toEqual({});
    expect({ ...sessionStorage }).toEqual({});
    expect(document.cookie).toBe('');
    expect(history.state).toBeNull();
  });
});
