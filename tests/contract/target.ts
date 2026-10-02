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
  /** Stop the server and clean up. */
  close(): Promise<void>;
}

export type CreateTarget = () => Promise<ContractTarget>;
