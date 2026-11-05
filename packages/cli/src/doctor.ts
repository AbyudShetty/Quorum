// Read-only local diagnostics. No setup, server start, credential writes, firewall changes or
// relaxed TLS checks. Network probes never join/register a Quorum identity or request a link.
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  checkPrivate,
  checkRelayUrl,
  DEFAULT_RELAY,
  defaultDataDir,
  openRelaySocket,
  readRemoteConfig,
} from '@quorum/local';
import type { CliEnv } from './cli.js';
import { findQuorumLauncher, quorumCommand } from './vendor-config.js';
import { vendorConfigPaths } from './vendor-paths.js';

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const jsonFile = async (path: string): Promise<unknown> =>
  JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')) as unknown;

const webSocketReachable = (relay: string): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = openRelaySocket(`${relay}/v1/connect/${randomBytes(32).toString('base64url')}`);
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.terminate();
      resolve(ok);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, 6000);
    socket.once('open', () => {
      finish(true);
    });
    socket.on('error', () => {
      finish(false);
    });
    socket.once('close', () => {
      finish(false);
    });
  });

export const doctor = async (args: string[], env: CliEnv, revision: number): Promise<number> => {
  const { values } = parseArgs({
    args,
    options: { offline: { type: 'boolean', default: false } },
    strict: true,
  });
  let failures = 0;
  const say = (level: 'OK' | 'WARN' | 'FAIL', text: string) => {
    if (level === 'FAIL') failures += 1;
    env.out(`${level} ${text}\n`);
  };
  env.out('Quorum doctor (read-only)\n');
  const dataDir = env.dataDir ?? defaultDataDir();
  if (!isAbsolute(dataDir))
    say(
      'FAIL',
      'QUORUM_HOME is relative. Use an absolute path so sessions in different folders share the same server and credential scope.',
    );
  const home = env.home ?? homedir();
  const command = await (env.quorumCommand ?? quorumCommand)();
  say(
    Number(process.versions.napi) >= 10 ? 'OK' : 'FAIL',
    `Node ${process.versions.node}, Node-API ${process.versions.napi ?? 'unavailable'}, ${process.platform}/${process.arch}`,
  );
  try {
    if (!(await stat(command.bin)).isFile()) throw new Error('Not a file');
    say('OK', `CLI entry: ${command.bin}`);
  } catch {
    say('FAIL', 'CLI entry is missing or unreadable. Reinstall the release package.');
  }
  const launcher = await findQuorumLauncher(env.path);
  if (!launcher)
    say(
      'WARN',
      'quorum is not on PATH. Check your global npm prefix before opening new terminals.',
    );
  else {
    try {
      const text = await readFile(launcher, 'utf8');
      if (/node_modules[\\/]@quorum[\\/]cli/.test(text))
        say(
          'FAIL',
          'PATH selects the old @quorum/cli development link. Remove that global link and install the release package.',
        );
      else say('OK', `PATH launcher: ${launcher}`);
    } catch {
      say(
        'WARN',
        'PATH launcher could not be inspected. Confirm it selects the intended Quorum installation.',
      );
    }
  }
  try {
    await stat(dataDir);
    const privacy = await checkPrivate(dataDir);
    say(
      privacy.ok ? 'OK' : 'FAIL',
      privacy.ok
        ? 'Data directory is private.'
        : `Data directory permissions need repair. ${privacy.fix}`,
    );
  } catch (error) {
    say(
      (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'WARN' : 'FAIL',
      'Data directory is absent or its permissions could not be verified.',
    );
  }
  let paths: ReturnType<typeof vendorConfigPaths> | undefined;
  try {
    paths = vendorConfigPaths(home, env.vendorConfigEnv);
    const settings = await jsonFile(paths.claudeSettings);
    const claude = await jsonFile(paths.claudeJson);
    const codex = await jsonFile(paths.codexHooks);
    for (const [name, value] of [
      ['Claude', settings],
      ['Codex', codex],
    ] as const) {
      const hooks = object(value) && object(value.hooks) ? value.hooks : undefined;
      const encoded = JSON.stringify(hooks?.PreToolUse ?? []);
      say(
        /quorum/i.test(encoded) && /pre-tool/.test(encoded) ? 'OK' : 'FAIL',
        `${name} Quorum tool-binding hooks ${/quorum/i.test(encoded) && /pre-tool/.test(encoded) ? 'found' : 'missing; run quorum setup'}.`,
      );
    }
    say(
      object(claude) && object(claude.mcpServers) && object(claude.mcpServers.quorum)
        ? 'OK'
        : 'FAIL',
      'Claude user-scope MCP configuration checked.',
    );
    const toml = await readFile(paths.codexConfig, 'utf8');
    say(
      /^\s*\[mcp_servers\.quorum\]\s*$/m.test(toml) ? 'OK' : 'FAIL',
      'Codex Quorum MCP table checked.',
    );
  } catch {
    say(
      'FAIL',
      'Vendor profile configuration is missing, unreadable or invalid. Check CODEX_HOME/CLAUDE_CONFIG_DIR and run quorum setup.',
    );
  }
  try {
    const marker = await jsonFile(join(dataDir, 'setup.json'));
    const current =
      object(marker) &&
      marker.complete === true &&
      marker.revision === revision &&
      marker.bin === command.bin &&
      marker.node === command.node &&
      paths !== undefined &&
      JSON.stringify(marker.config) === JSON.stringify(paths);
    say(
      current ? 'OK' : 'FAIL',
      current
        ? 'Setup matches this runtime and vendor profile.'
        : 'Setup is incomplete or stale. Run quorum setup.',
    );
  } catch {
    say('FAIL', 'No readable setup receipt. Run quorum setup.');
  }
  try {
    await env.store.load('__quorum_doctor_probe__');
    say('OK', 'OS credential-store read is available; no credential values displayed.');
  } catch {
    say(
      'FAIL',
      'OS keychain is unavailable. Check Credential Manager on Windows, Keychain on macOS, or Secret Service on Linux; no plaintext fallback is used.',
    );
  }
  if (values.offline) say('WARN', 'Relay network checks skipped (--offline).');
  else {
    try {
      const remote = await readRemoteConfig(dataDir);
      const selected = remote && 'relay' in remote ? remote.relay : (env.relay ?? DEFAULT_RELAY);
      const checked = checkRelayUrl(selected);
      if ('problem' in checked) throw new Error('Invalid relay configuration');
      const healthUrl = new URL('/health', checked.url.replace(/^ws/, 'http'));
      const response = await (env.fetch ?? fetch)(healthUrl, {
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      });
      const health: unknown = await response.json();
      say(
        response.ok && object(health) && health.status === 'ok' && health.relay === 'quorum-relay/1'
          ? 'OK'
          : 'FAIL',
        'Relay HTTP health response checked.',
      );
      say(
        (await webSocketReachable(checked.url)) ? 'OK' : 'FAIL',
        'Relay WebSocket upgrade checked.',
      );
    } catch {
      say(
        'FAIL',
        'Relay is unreachable or its response/configuration is invalid. Check DNS, internet, firewall/proxy and QUORUM_RELAY. TLS verification was not disabled.',
      );
    }
  }
  env.out('Vendor hook trust, full relay pairing and peer consent still require the live test.\n');
  return failures ? 1 : 0;
};
