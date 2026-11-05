// The one package people install (`npm install -g @quorumhq/quorum`, DECISIONS D-18) is staged
// from the built workspace packages by deploy/npm/pack.mjs. Needs `npm run build` first (as in
// `npm run check`).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

describe('release package (deploy/npm/pack.mjs)', () => {
  let out: string;
  let stage: string;
  let jsFiles: string[];

  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), 'quorum-pack-'));
    const obsolete = join(root, 'packages/server/dist/obsolete-pack-fixture.js');
    writeFileSync(obsolete, 'throw new Error("stale output must never ship");\n');
    try {
      execFileSync(process.execPath, [
        join(root, 'deploy/npm/pack.mjs'),
        '--stage-only',
        '--out',
        out,
      ]);
    } finally {
      rmSync(obsolete, { force: true });
    }
    stage = join(out, 'stage');
    jsFiles = readdirSync(stage, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.js'))
      .map((e) => join(e.parentPath, e.name));
  }, 60_000);

  afterAll(() => {
    rmSync(out, { recursive: true, force: true });
  });

  it('has the published name, the `quorum` command and only outside dependencies', () => {
    const pkg = readJson(join(stage, 'package.json'));
    expect(pkg).toMatchObject({
      name: '@quorumhq/quorum',
      bin: { quorum: 'bin/quorum.js' },
      license: 'Apache-2.0',
    });
    const deps = Object.keys(pkg.dependencies as Record<string, string>);
    expect(deps).toContain('better-sqlite3');
    expect(deps.filter((name) => name.startsWith('@quorum/'))).toEqual([]);
    expect(pkg).not.toHaveProperty('bundleDependencies');
  });

  it('ships the built JavaScript, the web assets and the licence, not sources or tests', () => {
    expect(existsSync(join(stage, 'LICENSE'))).toBe(true);
    expect(existsSync(join(stage, 'lib/web/assets/app.css'))).toBe(true);
    expect(existsSync(join(stage, 'lib/cli/bin/quorum.js'))).toBe(true);
    expect(existsSync(join(stage, 'lib/server/dist/local/serve-main.js'))).toBe(true);
    expect(existsSync(join(stage, 'lib/fleet'))).toBe(false);
    expect(existsSync(join(stage, 'lib/server/dist/obsolete-pack-fixture.js'))).toBe(false);
    const all = readdirSync(stage, { recursive: true }).map(String);
    expect(all.filter((f) => /(^|[\\/])(src|test)[\\/]|\.ts$|\.map$/.test(f))).toEqual([]);
  });

  it('checks the runtime before loading external dependencies from the installed entry point', () => {
    const entry = pathToFileURL(join(stage, 'bin/quorum.js')).href;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `Object.defineProperty(process.versions, 'node', {value:'20.20.2'}); await import(${JSON.stringify(entry)});`,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Quorum requires Node-API 10');
    expect(result.stderr).not.toContain('ERR_MODULE_NOT_FOUND');
  });

  it('turns every import of another Quorum package into a relative path that exists', () => {
    expect(jsFiles.length).toBeGreaterThan(20);
    for (const file of jsFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/\b(from|import)\s*\(?\s*['"]@quorum\//);
      for (const [, path] of source.matchAll(/\b(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
        expect(
          existsSync(resolve(dirname(file), path as string)),
          `${file} -> ${String(path)}`,
        ).toBe(true);
      }
    }
  });
});
