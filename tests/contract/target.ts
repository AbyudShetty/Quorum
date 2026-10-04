// What an implementation of /v1 provides so the contract suite can run against it.
// Track A's real server and Track B's fake server each ship a target module that exports
// `createTarget`, then run:  QUORUM_CONTRACT_TARGET=<path to module> npm test
export interface ContractPrincipal {
  /** e.g. "agent:claude-api@laptop-a" or "human:abyud". */
  address: string;
  /** A valid access token for this principal. */
  token: string;
}

export interface ContractTarget {
  /** e.g. "http://localhost:51234". */
  baseUrl: string;
  /** True when the server runs in local mode (Host/Origin checks apply, INV-26). */
  localMode: boolean;
  /** The Ed25519 public key a client would pin (base64url), INV-24. */
  pinnedPublicKey: string;
  /** A workspace that both agents and the human belong to. */
  workspace: string;
  agentA: ContractPrincipal;
  agentB: ContractPrincipal;
  human: ContractPrincipal;
  /**
   * Optional hooks for the cases added after the first freeze. A target without one skips the cases
   * that need it.
   */
  /** Create a folder the human can attach (it must exist on the server's machine in local mode). */
  makeFolder?(name: string): Promise<string>;
  /** Local mode: where `local/bootstrap.json` lives, and how to issue a new code (a restart). */
  bootstrap?: { dataDir: string; reissue(): Promise<void> };
  /** Move the server's clock forward (expiry and presence cases). */
  advanceClock?(ms: number): void;
  /** Stop the server and clean up. */
  close(): Promise<void>;
}

export type CreateTarget = () => Promise<ContractTarget>;
