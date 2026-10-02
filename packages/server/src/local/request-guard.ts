// Host and Origin checks for the local server (INV-26). A web page in the human's browser can
// send requests to localhost, and DNS rebinding can make "attacker.example" resolve to 127.0.0.1;
// both are stopped by accepting only our own loopback Host, and our own Origin for writes.
import { DomainError } from '@quorum/core';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const localHosts = (port: number): string[] => [
  `localhost:${String(port)}`,
  `127.0.0.1:${String(port)}`,
  `[::1]:${String(port)}`,
];

export interface RequestFacts {
  method: string;
  host: string | undefined;
  /** Browsers send it; CLIs and adapters usually do not. */
  origin: string | undefined;
}

/** Undefined if the request may proceed, otherwise the error to return. */
export const checkLocalRequest = (request: RequestFacts, port: number): DomainError | undefined => {
  const allowed = localHosts(port);
  const host = request.host?.toLowerCase();
  if (!host || !allowed.includes(host)) {
    return new DomainError(
      'forbidden',
      'request.foreign_host',
      'This local Quorum server only answers requests addressed to its own loopback address.',
      `Connect to http://localhost:${String(port)} directly.`,
    );
  }
  if (!SAFE_METHODS.has(request.method.toUpperCase()) && request.origin !== undefined) {
    const origin = request.origin.toLowerCase();
    if (!allowed.some((h) => origin === `http://${h}`)) {
      return new DomainError(
        'forbidden',
        'request.foreign_origin',
        'A web page from another site tried to change data on this local Quorum server.',
        'Use the Quorum UI at its own address; other sites cannot act on your behalf.',
      );
    }
  }
  return undefined;
};
