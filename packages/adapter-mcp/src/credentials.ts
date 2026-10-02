// Where an adapter keeps its tokens (INV-25, D-11): the OS keychain, never a plain-text file and
// never inside an attached project folder. One entry per attachment (or per human profile).

export interface StoredCredentials {
  access_token: string;
  refresh_token: string;
  /** Epoch ms after which the access token should be refreshed. */
  access_expires_at: number;
}

export interface CredentialStore {
  load(key: string): Promise<StoredCredentials | undefined>;
  save(key: string, credentials: StoredCredentials): Promise<void>;
  remove(key: string): Promise<void>;
}

const SERVICE = 'quorum';

const isCredentials = (value: unknown): value is StoredCredentials => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.access_token === 'string' &&
    typeof v.refresh_token === 'string' &&
    typeof v.access_expires_at === 'number'
  );
};

/**
 * Loaded on first use, so code that only needs the in-memory store (containers, the fleet harness)
 * never needs the native keychain binding.
 */
const entryFor = async (service: string, key: string) => {
  const { Entry } = await import('@napi-rs/keyring');
  return new Entry(service, key);
};

/** Windows Credential Manager, macOS Keychain or the Linux Secret Service. */
export class KeychainCredentialStore implements CredentialStore {
  readonly #service: string;

  constructor(service: string = SERVICE) {
    this.#service = service;
  }

  async load(key: string): Promise<StoredCredentials | undefined> {
    const raw = (await entryFor(this.#service, key)).getPassword();
    if (!raw) return undefined;
    try {
      const parsed: unknown = JSON.parse(raw);
      return isCredentials(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async save(key: string, credentials: StoredCredentials): Promise<void> {
    (await entryFor(this.#service, key)).setPassword(JSON.stringify(credentials));
  }

  async remove(key: string): Promise<void> {
    (await entryFor(this.#service, key)).deletePassword();
  }
}

/** For tests and for callers that are handed tokens for one run. Nothing is written anywhere. */
export class MemoryCredentialStore implements CredentialStore {
  readonly #entries = new Map<string, StoredCredentials>();

  load(key: string): Promise<StoredCredentials | undefined> {
    return Promise.resolve(this.#entries.get(key));
  }

  save(key: string, credentials: StoredCredentials): Promise<void> {
    this.#entries.set(key, credentials);
    return Promise.resolve();
  }

  remove(key: string): Promise<void> {
    this.#entries.delete(key);
    return Promise.resolve();
  }
}
