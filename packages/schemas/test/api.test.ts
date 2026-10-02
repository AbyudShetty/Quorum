import { describe, expect, it } from 'vitest';
import { type ApiPayloadKind, type ApiPayloads, validateApiPayload } from '../src/index.js';
import { envelope, HASH, U1, U2 } from './fixtures.js';

const TOKEN = 'q'.repeat(43);

/** One valid example per API payload, typed so types and schemas are checked together. */
const examples: ApiPayloads = {
  health: { status: 'ok', spec: 'quorum/1', version: '0.1.0', instance_id: U1 },
  helloRequest: { nonce: 'n'.repeat(43) },
  helloResponse: { instance_id: U1, public_key: 'k'.repeat(43), signature: 's'.repeat(86) },
  tokenRefreshRequest: { refresh_token: TOKEN },
  tokenPair: {
    access_token: TOKEN,
    refresh_token: TOKEN,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_expires_in: 2_592_000,
  },
  workspaceCreate: { name: 'amazon-ml-2026' },
  workspace: { id: `ws_${U1}`, name: 'amazon-ml-2026', created_at: '2026-10-02T10:00:00Z' },
  workspaceList: { workspaces: [] },
  attachmentCreate: {
    root: 'C:\\Users\\abyud\\proj\\api',
    vendor: 'claude-code',
    workspaces: [`ws_${U1}`],
    wake: 'direct',
  },
  attachmentCreated: {
    attachment: {
      id: `at_${U1}`,
      root: '/home/abhijna/proj/web',
      vendor: 'codex',
      workspaces: [`ws_${U1}`],
      wake: 'off',
      lease_enforcement: 'warn',
    },
    agent: { id: `ag_${U1}`, address: 'agent:codex-web@laptop-b' },
    credentials: {
      access_token: TOKEN,
      refresh_token: TOKEN,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_expires_in: 2_592_000,
    },
  },
  agentRef: { id: `ag_${U1}`, address: 'agent:claude-api@laptop-a' },
  sessionCreate: {
    vendor_session_id: '3f0c2a5e-session',
    root: 'C:\\Users\\abyud\\proj\\api',
    git: {
      common_dir: 'C:\\Users\\abyud\\proj\\api\\.git',
      worktree_root: 'C:\\Users\\abyud\\proj\\api',
    },
  },
  sessionCreated: {
    session_id: `sess_${U1}`,
    agent: { id: `ag_${U1}`, address: 'agent:claude-api@laptop-a' },
    repo: `rp_${U1}`,
    worktree: `wt_${U1}`,
    shared_worktree_with: ['agent:codex-api@laptop-a'],
  },
  messageAccepted: {
    id: `msg_${U1}`,
    seq: 42,
    received_at: '2026-10-02T10:00:01Z',
    event: `ev_${U1}`,
  },
  inboxPage: {
    messages: [
      { ...envelope('note'), seq: 42, received_at: '2026-10-02T10:00:01Z', event: `ev_${U1}` },
    ],
    next_after: 42,
    has_more: false,
  },
  ackRequest: { up_to: 42 },
  agentList: {
    agents: [
      {
        id: `ag_${U1}`,
        address: 'agent:claude-api@laptop-a',
        vendor: 'claude-code',
        presence: 'online',
        status: 'working',
        current_task: `tk_${U2}`,
      },
    ],
  },
  event: {
    ev_id: `ev_${U1}`,
    workspace: `ws_${U1}`,
    seq: 1,
    ts: '2026-10-02T10:00:01Z',
    actor: 'system:quorum',
    kind: 'workspace.created',
    payload: { name: 'amazon-ml-2026' },
    prev_hash: HASH,
    hash: 'b'.repeat(64),
  },
};

const issues = (kind: ApiPayloadKind, input: unknown): string[] => {
  const result = validateApiPayload(kind, input);
  return result.ok ? [] : result.issues.map((i) => `${i.path} ${i.rule}`);
};

describe('API payloads', () => {
  it.each(Object.keys(examples) as ApiPayloadKind[])('accepts a valid %s', (kind) => {
    expect(issues(kind, examples[kind])).toEqual([]);
  });

  it('requires a 32-byte nonce for the identity handshake (INV-24)', () => {
    expect(issues('helloRequest', { nonce: 'short' })).toEqual(['/nonce pattern']);
  });

  it('requires a 64-byte signature and a 32-byte public key', () => {
    expect(
      issues('helloResponse', { ...examples.helloResponse, signature: 's'.repeat(43) }),
    ).toEqual(['/signature pattern']);
  });

  it('only attaches absolute folders', () => {
    expect(issues('attachmentCreate', { ...examples.attachmentCreate, root: 'proj/api' })).toEqual([
      '/root pattern',
    ]);
  });

  it('only accepts known vendors and wake modes', () => {
    expect(
      issues('attachmentCreate', {
        ...examples.attachmentCreate,
        vendor: 'cursor',
        wake: 'always',
      }),
    ).toEqual(['/vendor enum', '/wake enum']);
  });

  it('attaches to at least one workspace', () => {
    expect(issues('attachmentCreate', { ...examples.attachmentCreate, workspaces: [] })).toEqual([
      '/workspaces minItems',
    ]);
  });

  it('only accepts bearer tokens in token pairs', () => {
    expect(issues('tokenPair', { ...examples.tokenPair, token_type: 'Basic' })).toEqual([
      '/token_type const',
    ]);
  });

  it('validates every message inside an inbox page', () => {
    const page = {
      ...examples.inboxPage,
      messages: [{ ...examples.inboxPage.messages[0], seq: 0 }],
    };
    expect(issues('inboxPage', page)).toEqual(['/messages/0/seq minimum']);
  });

  it('requires hash-chain fields on exported events (INV-8)', () => {
    expect(issues('event', { ...examples.event, prev_hash: undefined })).toEqual([' required']);
  });
});
