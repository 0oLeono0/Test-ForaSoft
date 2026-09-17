import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { MAX_PARTICIPANTS } from '@vcr/shared';
import { describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('./index.js', import.meta.url));

describe('server: тестовый раннер', () => {
  it('выполняется в Node.js не ниже 20 (engines)', () => {
    const major = Number(process.versions.node.split('.')[0]);
    expect(major).toBeGreaterThanOrEqual(20);
    expect(typeof document).toBe('undefined');
  });

  it('импортирует @vcr/shared через Vitest', () => {
    expect(MAX_PARTICIPANTS).toBe(4);
  });

  it('импортирует @vcr/shared при запуске точки входа в Node', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, [ENTRY]);
    expect(stdout).toContain('MAX_PARTICIPANTS=4');
  });
});
