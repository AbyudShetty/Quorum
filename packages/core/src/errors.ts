// Domain errors. Core knows nothing about HTTP: the server maps `kind` to a status code and
// the fields to the ErrorResponse shape (MESSAGE_SPEC §6).

export type DomainErrorKind =
  | 'invalid' // 400
  | 'unauthorized' // 401
  | 'forbidden' // 403
  | 'not_found' // 404
  | 'conflict' // 409
  | 'too_large' // 413
  | 'rate_limited'; // 429 (with Retry-After)

export class DomainError extends Error {
  constructor(
    readonly kind: DomainErrorKind,
    /** Stable, documented code, e.g. "message.sender_mismatch". */
    readonly code: string,
    message: string,
    /** The exact next step for the caller. */
    readonly fix: string,
    /** JSON Pointer to the offending input, when there is one. */
    readonly path?: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }

  /** The ErrorResponse body for this error. */
  toResponse(): { error: { code: string; message: string; fix: string; path?: string } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        fix: this.fix,
        ...(this.path === undefined ? {} : { path: this.path }),
      },
    };
  }
}
