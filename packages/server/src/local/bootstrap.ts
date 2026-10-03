// Issues and redeems the local bootstrap code (ARCHITECTURE §6). On each start the local server
// writes one code (single use, 10 minutes) into the private data directory; whoever can read it is
// the owning OS user (INV-25) and may exchange it for the owner's human tokens. Only the hash is
// kept in memory, the file is removed once the code is spent or expired, and a restart issues a
// new one. Same-user processes can read it too: the residual risk in THREAT_MODEL §6.7.
import {
  BOOTSTRAP_CODE_TTL_SECONDS,
  type BootstrapDecision,
  type BootstrapRecord,
  decideBootstrap,
  generateToken,
  hashToken,
} from '@quorum/core';
import { removeBootstrapCode, writeBootstrapCode } from '@quorum/local';

export interface LocalBootstrapOptions {
  now?: () => Date;
  random?: (size: number) => Uint8Array;
}

export class LocalBootstrap {
  private record: BootstrapRecord | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => Date;
  private readonly random: ((size: number) => Uint8Array) | undefined;

  constructor(
    private readonly dataDir: string,
    options: LocalBootstrapOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random;
  }

  /** Write a new code, replacing any earlier one. Returns when it expires (RFC 3339). */
  async issue(): Promise<string> {
    this.clearTimer();
    const code = generateToken('bootstrap', this.random);
    const expiresAt = new Date(
      this.now().getTime() + BOOTSTRAP_CODE_TTL_SECONDS * 1000,
    ).toISOString();
    this.record = { hash: hashToken(code), expires_at: expiresAt, used: false };
    await writeBootstrapCode(this.dataDir, { code, expires_at: expiresAt });
    // Remove the file at expiry so a stale secret does not linger on disk.
    this.timer = setTimeout(() => void this.discard(), BOOTSTRAP_CODE_TTL_SECONDS * 1000);
    this.timer.unref();
    return expiresAt;
  }

  /**
   * Check a presented code. On "accept" the code is spent before this returns (synchronously, so
   * two concurrent requests cannot both succeed); the caller then issues the human's tokens.
   */
  async redeem(code: string): Promise<BootstrapDecision> {
    const decision = decideBootstrap(this.record, code, this.now());
    if (decision.outcome === 'accept' || decision.reason === 'expired') {
      if (this.record) this.record.used = true;
      await this.discard();
    }
    return decision;
  }

  /** Forget the code and remove its file (on use, expiry and shutdown). */
  async discard(): Promise<void> {
    this.clearTimer();
    if (this.record) this.record.used = true;
    await removeBootstrapCode(this.dataDir);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
