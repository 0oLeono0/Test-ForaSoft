import { describe, expect, it } from 'vitest';
import * as constants from './constants.js';
import * as errors from './errors.js';
import * as events from './events.js';
import * as shared from './index.js';
import * as validation from './validation.js';

const MODULES = { constants, errors, events, validation };

describe('@vcr/shared: barrel-экспорт', () => {
  it.each(Object.entries(MODULES))('реэкспортирует всё из %s.js', (_name, module) => {
    for (const [exportName, value] of Object.entries(module)) {
      expect(shared[exportName], exportName).toBe(value);
    }
  });

  it('не экспортирует ничего сверх модулей пакета', () => {
    const moduleExports = Object.values(MODULES).flatMap((module) => Object.keys(module));
    expect(Object.keys(shared).sort()).toEqual(moduleExports.sort());
  });
});
