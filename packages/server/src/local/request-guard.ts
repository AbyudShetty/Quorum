// Host and Origin checks for the local server (INV-26). A web page in the human's browser can
// send requests to localhost, and DNS rebinding can make "attacker.example" resolve to 127.0.0.1;
// both are stopped by accepting only our own loopback Host, and our own Origin for writes.
//
// With remote access on (Phase 1b, ARCHITECTURE §8.3) the server still listens on loopback only; an
// HTTPS front end on this machine (`tailscale serve`, `cloudflared`) forwards other machines'
// requests. Those arrive addressed to the public name, or carrying the front end's forwarding
// headers, and count as remote: they need tokens like any request (INV-23) and cannot use the
// local-only routes. Claiming to be remote only ever takes rights away.
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
  /** Set by a forwarding front end (X-Forwarded-For, Cf-Connecting-Ip, Tailscale-User-Login). */
  forwarded?: boolean;
}

/** Where a request may come from: refused, or accepted as local or remote. */
export type RequestOrigin = { refused: DomainError } | { remote: boolean };

/**
 * Classify a request. `publicUrl` is the front end's address (`https://host[:port]`) when remote
 * access is on.
 */
export const classifyRequest = (
  request: RequestFacts,
  port: number,
  publicUrl?: string,
): RequestOrigin => {
  const loopback = localHosts(port);
  const publicHost = publicUrl ? new URL(publicUrl).host.toLowerCase() : undefined;
  const host = request.host?.toLowerCase();
  const toPublic = publicHost !== undefined && host === publicHost;
  if (!host || (!loopback.includes(host) && !toPublic)) {
    return {
      refused: new DomainError(
        'forbidden',
        'request.foreign_host',
        'This Quorum server only answers requests addressed to its own address.',
        publicUrl
          ? `Connect to ${publicUrl} (or http://localhost:${String(port)} on this machine).`
          : `Connect to http://localhost:${String(port)} directly.`,
      ),
    };
  }
  if (!SAFE_METHODS.has(request.method.toUpperCase()) && request.origin !== undefined) {
    const origin = request.origin.toLowerCase();
    const ours =
      loopback.some((h) => origin === `http://${h}`) || origin === publicUrl?.toLowerCase();
    if (!ours) {
      return {
        refused: new DomainError(
          'forbidden',
          'request.foreign_origin',
          'A web page from another site tried to change data on this Quorum server.',
          'Use the Quorum UI at its own address; other sites cannot act on your behalf.',
        ),
      };
    }
  }
  return { remote: toPublic || request.forwarded === true };
};

/** Undefined if the request may proceed, otherwise the error to return (loopback-only servers). */
export const checkLocalRequest = (request: RequestFacts, port: number): DomainError | undefined => {
  const result = classifyRequest(request, port);
  return 'refused' in result ? result.refused : undefined;
};
