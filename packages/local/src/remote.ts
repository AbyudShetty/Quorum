// Remote access settings `<data dir>/local/remote.json` (ARCHITECTURE §8.3, Phase 1b). The server
// itself keeps listening on loopback only; an HTTPS front end on the same machine (`tailscale
// serve`, or `cloudflared` for Cloudflare Tunnel) carries other machines' requests to it. This file
// tells the server that front end's public address (to accept it as Host) and the fixed port it
// forwards to. Written by `quorum remote enable`, read on every server start (auto-start too). No
// secrets. A malformed file is ignored, so remote access is off rather than half on.
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { writePrivateFile } from './data-dir.js';

export interface RemoteConfig {
  /** The front end's address: https://<host>[:port], no path. TLS ends there (INV-22). */
  public_url: string;
  /** The loopback port the server listens on and the front end forwards to. */
  port: number;
}

export const remoteConfigPath = (dataDir: string): string => join(dataDir, 'local', 'remote.json');

/**
 * The public address in canonical form (`https://host[:port]`), or why it cannot be used. Only
 * HTTPS: traffic between machines is always encrypted (INV-22); the front end holds the certificate.
 */
export const checkPublicUrl = (text: string): { url: string } | { problem: string } => {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return {
      problem: 'not a URL; expected https://<host>, e.g. https://my-laptop.tail1234.ts.net',
    };
  }
  if (url.protocol !== 'https:') {
    return { problem: 'must start with https:// (traffic between machines is always encrypted)' };
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    return { problem: 'must be just https://<host> or https://<host>:<port>, with no path' };
  }
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    return { problem: 'must be the address other machines use, not localhost' };
  }
  return { url: url.origin };
};

const valid = (value: unknown): value is RemoteConfig => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.public_url === 'string' &&
    'url' in checkPublicUrl(v.public_url) &&
    typeof v.port === 'number' &&
    Number.isInteger(v.port) &&
    v.port >= 1024 &&
    v.port <= 65535
  );
};

export const writeRemoteConfig = (dataDir: string, config: RemoteConfig): Promise<void> =>
  writePrivateFile(remoteConfigPath(dataDir), `${JSON.stringify(config, null, 2)}\n`);

/** The settings, or undefined when remote access is off (no file, or a malformed one). */
export const readRemoteConfig = async (dataDir: string): Promise<RemoteConfig | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(remoteConfigPath(dataDir), 'utf8'));
    return valid(parsed) ? { public_url: parsed.public_url, port: parsed.port } : undefined;
  } catch {
    return undefined;
  }
};

export const removeRemoteConfig = (dataDir: string): Promise<void> =>
  rm(remoteConfigPath(dataDir), { force: true });
