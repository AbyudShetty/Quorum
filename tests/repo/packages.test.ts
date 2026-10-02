// Every workspace package follows the same layout (CONTRIBUTING "Adding a package"),
// so either track can add packages without touching the other's.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SPEC_VERSION } from '@quorum/schemas';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(root, path), 'utf8'));

const packages = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

const buildReferences = (
  readJson('config/tsconfig.build.json') as { references: { path: string }[] }
).references;

describe('workspace packages', () => {
  it('exist', () => {
    expect(packages.length).toBeGreaterThan(0);
  });

  describe.each(packages)('packages/%s', (name) => {
    const dir = `packages/${name}`;

    it('has the standard package.json fields', () => {
      expect(readJson(`${dir}/package.json`)).toMatchObject({
        name: `@quorum/${name}`,
        private: true,
        license: 'Apache-2.0',
        type: 'module',
        exports: {
          '.': {
            'quorum-source': './src/index.ts',
            types: './dist/index.d.ts',
            default: './dist/index.js',
          },
        },
      });
    });

    it.each(['tsconfig.json', 'tsconfig.build.json', 'README.md', 'src/index.ts'])(
      'has %s',
      (file) => {
        expect(existsSync(join(root, dir, file))).toBe(true);
      },
    );

    it('is referenced from config/tsconfig.build.json', () => {
      expect(buildReferences).toContainEqual({ path: `../${dir}/tsconfig.build.json` });
    });
  });

  it('resolves workspace imports to source', () => {
    expect(SPEC_VERSION).toBe('quorum/1');
  });
});
