import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const helperUrl = new URL('../bin/runtime.js', import.meta.url).href;
const { runtimeError } = (await import(helperUrl)) as {
  runtimeError: (version: string, napi: string) => string | undefined;
};

describe('CLI runtime compatibility', () => {
  it.each([
    '22.14.0',
    '22.23.4',
    '23.6.0',
    '23.11.1',
    '24.22.2',
    '25.2.0',
    '26.13.0',
    '27.0.0-alpha.0.0.0',
  ])('accepts Node %s without restricting release parity', (version) => {
    expect(runtimeError(version, '10')).toBeUndefined();
  });

  it.each(['18.20.8', '20.20.2', '22.12.0', '22.13.1', '23.0.0', '23.5.0', 'unknown'])(
    'explains the dependency minimum for Node %s',
    (version) => {
      expect(runtimeError(version, '9')).toContain('Node-API 10');
      expect(runtimeError(version, '9')).toContain(version);
    },
  );

  it('rejects an old runtime before importing dependencies or writing setup', () => {
    const bin = new URL('../bin/quorum.js', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `Object.defineProperty(process.versions, 'node', {value:'20.20.2'}); await import(${JSON.stringify(bin)});`,
      ],
      { encoding: 'utf8', cwd: fileURLToPath(new URL('..', import.meta.url)) },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Quorum requires Node-API 10');
    expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
    expect(result.stdout).toBe('');
  });
});
