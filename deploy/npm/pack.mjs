#!/usr/bin/env node
// Builds the one package people install: `npm install -g @quorumhq/quorum` (DECISIONS D-18).
//
// The repository is a set of workspace packages. This copies the built ones the `quorum` command
// needs into lib/<package>/ of a staging folder, turns their imports of each other
// (`from '@quorum/core'`) into relative paths, lists their outside dependencies at the top level
// (installed with the package; none runs code at install time) and runs `npm pack`.
// (npm's bundleDependencies does not work here: npm then expects every dependency of a bundled
// package inside the bundle too, and installs none of them.)
// Run with `npm run pack:release` (builds first). The package file lands in deploy/npm/out/.
// `--stage-only --out <dir>` stops before `npm pack` (tests/repo/release-package.test.ts).
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const { values: flags } = parseArgs({
  options: { 'stage-only': { type: 'boolean' }, out: { type: 'string' } },
});
const out = flags.out ?? join(here, 'out');
const stage = join(out, 'stage');

// Everything the `quorum` command loads at run time (the fleet is a test tool and stays out).
const INTERNAL = [
  'schemas',
  'core',
  'local',
  'web',
  'server',
  'adapter-mcp',
  'adapter-hooks',
  'codex-bridge',
  'relay',
  'cli',
];

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );
const filesUnder = async (dir) =>
  (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));

const manifest = await readJson(join(here, 'manifest.json'));
await rm(out, { recursive: true, force: true });
await mkdir(stage, { recursive: true });

const libOf = new Map(); // '@quorum/core' -> <stage>/lib/core
const outside = {};
for (const dir of INTERNAL) {
  const from = join(root, 'packages', dir);
  const pkg = await readJson(join(from, 'package.json'));
  if (!(await exists(join(from, 'dist', 'index.js')))) {
    throw new Error(`${pkg.name} is not built: run \`npm run build\` first`);
  }
  const to = join(stage, 'lib', dir);
  libOf.set(pkg.name, to);
  for (const entry of pkg.files ?? ['dist']) {
    await cp(join(from, entry), join(to, entry), {
      recursive: true,
      // Source maps and type declarations are for development; the package runs the JavaScript.
      filter: (path) => !/\.(map|d\.ts|tsbuildinfo)$/.test(path),
    });
  }
  for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
    if (name.startsWith('@quorum/')) continue;
    if (outside[name] && outside[name] !== range) {
      throw new Error(`${name}: ${outside[name]} and ${range} are both wanted; align them first`);
    }
    outside[name] = range;
  }
}

// `from '@quorum/core'` / `import('@quorum/server')` -> a relative path to that package's entry.
const specifier = /(\bfrom\s*|\bimport\s*\(\s*)(['"])(@quorum\/[a-z-]+)\2/g;
for (const [, lib] of libOf) {
  for (const file of (await filesUnder(lib)).filter((f) => f.endsWith('.js'))) {
    const source = await readFile(file, 'utf8');
    const rewritten = source.replace(specifier, (_, lead, quote, name) => {
      const target = libOf.get(name);
      if (!target) throw new Error(`${file} imports ${name}, which is not packaged`);
      let path = relative(dirname(file), join(target, 'dist', 'index.js'))
        .split(sep)
        .join('/');
      if (!path.startsWith('.')) path = `./${path}`;
      return `${lead}${quote}${path}${quote}`;
    });
    if (rewritten !== source) await writeFile(file, rewritten);
  }
}

// The command itself.
await mkdir(join(stage, 'bin'), { recursive: true });
await writeFile(
  join(stage, 'bin', 'quorum.js'),
  "#!/usr/bin/env node\nimport { runFromProcess } from '../lib/cli/dist/index.js';\n\nprocess.exitCode = await runFromProcess(process.argv.slice(2));\n",
);
await cp(join(root, 'LICENSE'), join(stage, 'LICENSE'));
await cp(join(here, 'README.md'), join(stage, 'README.md'));

const sorted = (object) =>
  Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : 1)));
await writeFile(
  join(stage, 'package.json'),
  `${JSON.stringify(
    { ...manifest, files: ['bin', 'lib', 'LICENSE', 'README.md'], dependencies: sorted(outside) },
    null,
    2,
  )}\n`,
);

if (flags['stage-only']) process.exit(0);

// Under `npm run`, npm says where it lives, so it runs without a shell (npm is a .cmd on Windows).
const args = ['pack', '--ignore-scripts', '--pack-destination', '..'];
const options = { cwd: stage, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' };
const npmCli = process.env.npm_execpath;
const result = npmCli?.endsWith('.js')
  ? spawnSync(process.execPath, [npmCli, ...args], options)
  : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      ...options,
      shell: process.platform === 'win32',
    });
if (result.status !== 0) throw new Error(`npm pack failed (${String(result.status)})`);
const file = result.stdout.trim().split('\n').at(-1);
console.log(`\nBuilt ${join(out, file)}\nInstall it with:  npm install -g "${join(out, file)}"`);
