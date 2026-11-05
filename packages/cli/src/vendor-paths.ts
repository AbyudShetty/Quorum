import { isAbsolute, join, normalize } from 'node:path';

export interface VendorConfigEnv {
  CODEX_HOME?: string;
  CLAUDE_CONFIG_DIR?: string;
}

const configRoot = (
  name: string,
  value: string | undefined,
  fallback: string,
  home: string,
): string => {
  if (!value) return fallback;
  const expanded =
    value === '~' ? home : /^~[\\/]/.test(value) ? join(home, value.slice(2)) : value;
  if (!isAbsolute(expanded) || expanded.includes('\0'))
    throw new Error(`${name} must name an absolute configuration directory.`);
  return normalize(expanded);
};

/** The vendor's active user profile; never silently install into a different account/profile. */
export const vendorConfigPaths = (home: string, env: VendorConfigEnv = {}) => {
  const claude = configRoot(
    'CLAUDE_CONFIG_DIR',
    env.CLAUDE_CONFIG_DIR,
    join(home, '.claude'),
    home,
  );
  const codex = configRoot('CODEX_HOME', env.CODEX_HOME, join(home, '.codex'), home);
  return {
    claudeSettings: join(claude, 'settings.json'),
    claudeJson: env.CLAUDE_CONFIG_DIR ? join(claude, '.claude.json') : join(home, '.claude.json'),
    claudeCommands: join(claude, 'commands'),
    codexHooks: join(codex, 'hooks.json'),
    codexConfig: join(codex, 'config.toml'),
    codexSkills: join(codex, 'skills'),
  };
};
