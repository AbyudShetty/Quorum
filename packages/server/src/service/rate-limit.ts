// Fixed-window rate limits per key (INV-15, INV-23). In memory: a restart resets the windows, which
// is fine for limits measured in minutes. Exceeding a limit fails only that key's requests.
import { DomainError } from '@quorum/core';

const MAX_KEYS = 10_000;

export class RateLimiter {
  readonly #windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one request for `key`; throws a 429 DomainError (with retry time) when over the limit. */
  take(key: string, what: string): void {
    const now = this.now();
    let window = this.#windows.get(key);
    if (!window || now - window.start >= this.windowMs) {
      if (this.#windows.size >= MAX_KEYS) this.#prune(now);
      window = { start: now, count: 0 };
      this.#windows.set(key, window);
    }
    window.count++;
    if (window.count > this.limit) {
      const retryAfter = Math.max(1, Math.ceil((window.start + this.windowMs - now) / 1000));
      throw new RateLimitError(what, this.limit, this.windowMs, retryAfter);
    }
  }

  #prune(now: number): void {
    for (const [key, window] of this.#windows) {
      if (now - window.start >= this.windowMs) this.#windows.delete(key);
    }
    // Still full (a flood of distinct keys): forget the oldest half rather than grow without bound.
    if (this.#windows.size >= MAX_KEYS) {
      let drop = Math.floor(this.#windows.size / 2);
      for (const key of this.#windows.keys()) {
        if (drop-- <= 0) break;
        this.#windows.delete(key);
      }
    }
  }
}

export class RateLimitError extends DomainError {
  constructor(
    what: string,
    limit: number,
    windowMs: number,
    readonly retryAfterSeconds: number,
  ) {
    super(
      'rate_limited',
      'rate.limited',
      `Too many ${what}: the limit is ${String(limit)} per ${String(Math.round(windowMs / 1000))} s.`,
      `Wait ${String(retryAfterSeconds)} s (see Retry-After) and try again.`,
    );
    this.name = 'RateLimitError';
  }
}
