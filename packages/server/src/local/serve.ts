// `quorum serve --local` (ARCHITECTURE §8.2): one server per OS user, loopback only (INV-22), in a
// private data directory (INV-25), published through the discovery file, with a fresh bootstrap
// code on every start (ARCHITECTURE §6) and an idle shutdown.
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { createIdFactory } from '@quorum/core';
import {
  acquireStartLock,
  defaultDataDir,
  ensurePrivateDir,
  readDiscovery,
  removeDiscovery,
  writeDiscovery,
} from '@quorum/local';
import { buildApp } from '../http/app.js';
import { Quorum } from '../service/quorum.js';
import { openDatabase } from '../storage/database.js';
import { Registry } from '../storage/registry.js';
import { SqliteEventStore } from '../storage/sqlite-event-store.js';
import { LocalBootstrap } from './bootstrap.js';
import { loadOrCreateInstance } from './instance.js';

export const SERVER_VERSION = '0.1.0-dev';

export interface LocalServerOptions {
  /** Default: QUORUM_HOME, else %LOCALAPPDATA%\Quorum or ~/.quorum. */
  dataDir?: string;
  /** Default: any free port. */
  port?: number;
  /** Shut down after this long with no requests and no open streams. Default 30 min; 0 = never. */
  idleShutdownMs?: number;
  /** Agent address host part. Default: this computer's name. */
  machine?: string;
  /** Owner human name. Default: the OS user name. */
  ownerName?: string;
  version?: string;
  /** Server clock (tests). Default: the system clock. */
  clock?: () => Date;
}

export interface LocalServer {
  dataDir: string;
  port: number;
  baseUrl: string;
  instanceId: string;
  publicKey: string;
  quorum: Quorum;
  /** Write a new bootstrap code, replacing the current one (what a restart does). */
  issueBootstrap(): Promise<void>;
  /** Resolves once the server has stopped (also after an idle shutdown). */
  closed: Promise<void>;
  close(): Promise<void>;
}

export class AlreadyRunningError extends Error {
  constructor(readonly holderPid: number) {
    super(`A local Quorum server is already running (pid ${String(holderPid)}).`);
    this.name = 'AlreadyRunningError';
  }
}

/** A name that fits the address rule `[a-z][a-z0-9-]{0,31}`, e.g. "DESKTOP-AB12" → "desktop-ab12". */
export const addressName = (text: string, fallback: string): string => {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 32)
    .replace(/-+$/, '');
  return slug || fallback;
};

const osUserName = (): string => {
  try {
    return userInfo().username;
  } catch {
    return '';
  }
};

export const startLocalServer = async (options: LocalServerOptions = {}): Promise<LocalServer> => {
  const dataDir = options.dataDir ?? defaultDataDir();
  await ensurePrivateDir(dataDir); // refuses to run if it cannot be made private (INV-25)
  await mkdir(join(dataDir, 'local'), { recursive: true });

  const attempt = await acquireStartLock(dataDir);
  if (!attempt.acquired) throw new AlreadyRunningError(attempt.holderPid);
  const lock = attempt.lock;

  const db = (() => {
    try {
      return openDatabase(join(dataDir, 'quorum.db'));
    } catch (error) {
      void lock.release();
      throw error;
    }
  })();
  // Undone in reverse: streams, HTTP, discovery and code first; the database before the lock.
  const cleanups: (() => Promise<void> | void)[] = [
    () => lock.release(),
    () => {
      db.close();
    },
  ];
  const cleanUp = async () => {
    for (const step of cleanups.splice(0).reverse()) {
      try {
        await step();
      } catch {
        // Keep going: every remaining step still has to run.
      }
    }
  };

  try {
    const ids = createIdFactory();
    const instance = await loadOrCreateInstance(dataDir, ids);
    const quorum = await Quorum.open({
      db,
      registry: new Registry(db),
      store: new SqliteEventStore(db),
      ids,
      mode: 'local',
      dataDir,
      machine: options.machine ?? addressName(hostname(), 'machine'),
      ownerName: options.ownerName ?? addressName(osUserName(), 'owner'),
      ...(options.clock ? { clock: options.clock } : {}),
    });
    const bootstrap = new LocalBootstrap(dataDir, options.clock ? { now: options.clock } : {});
    let lastActivity = Date.now();
    let port = 0;
    const app = buildApp({
      quorum,
      instance,
      version: options.version ?? SERVER_VERSION,
      mode: 'local',
      bootstrap,
      port: () => port,
      onActivity: () => {
        lastActivity = Date.now();
      },
    });
    // Loopback only, never configurable in local mode (INV-22).
    await app.listen({ host: '127.0.0.1', port: options.port ?? 0 });
    cleanups.push(() => app.close());
    cleanups.push(() => {
      quorum.close(); // ends open streams, so closing the HTTP server does not wait on them
    });
    port = (app.server.address() as AddressInfo).port;

    await writeDiscovery(dataDir, {
      instance_id: instance.instanceId,
      pid: process.pid,
      port,
      public_key: instance.publicKey,
      version: options.version ?? SERVER_VERSION,
      started_at: new Date().toISOString(),
    });
    cleanups.push(async () => {
      // Only remove the discovery file if it is still ours.
      if ((await readDiscovery(dataDir))?.instance_id === instance.instanceId) {
        await removeDiscovery(dataDir);
      }
    });
    await bootstrap.issue();
    cleanups.push(() => bootstrap.discard());

    const timers = [
      setInterval(() => {
        quorum.sweepPresence();
      }, 10_000),
      setInterval(() => {
        quorum.pruneTokens();
      }, 3_600_000),
    ];
    const idleMs = options.idleShutdownMs ?? 30 * 60_000;
    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((done) => {
      resolveClosed = done;
    });
    let closing: Promise<void> | undefined;
    const close = () => {
      closing ??= (async () => {
        for (const timer of timers) clearInterval(timer);
        await cleanUp();
        resolveClosed();
      })();
      return closing;
    };
    if (idleMs > 0) {
      timers.push(
        setInterval(
          () => {
            if (quorum.notifier.size === 0 && Date.now() - lastActivity >= idleMs) void close();
          },
          Math.min(60_000, idleMs),
        ),
      );
    }
    for (const timer of timers) timer.unref();

    return {
      dataDir,
      port,
      baseUrl: `http://localhost:${String(port)}`,
      instanceId: instance.instanceId,
      publicKey: instance.publicKey,
      quorum,
      issueBootstrap: async () => {
        await bootstrap.issue();
      },
      closed,
      close,
    };
  } catch (error) {
    await cleanUp();
    throw error;
  }
};
