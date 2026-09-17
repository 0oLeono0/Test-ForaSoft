import { describe, expect, it } from 'vitest';

describe('client: тестовый раннер', () => {
  it('выполняется в jsdom с матчерами jest-dom', () => {
    const heading = document.createElement('h1');
    heading.textContent = 'Видеочат';
    document.body.append(heading);

    expect(heading).toBeInTheDocument();
    expect(heading).toHaveTextContent('Видеочат');
  });
});
