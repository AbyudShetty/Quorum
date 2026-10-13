import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { LinkInfo } from '@quorum/schemas';
import { describe, expect, it } from 'vitest';
import {
  type AttachmentInfo,
  createPairingMcpServer,
  PAIRING_INSTRUCTIONS,
  type PairedTarget,
  type QuorumClient,
} from '../src/index.js';

describe('MCP tools in pairing mode (D-20)', () => {
  it('tell a session that has not joined how to, for every tool', async () => {
    const server = createPairingMcpServer({ resolve: () => Promise.resolve(undefined) });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const mcp = new Client({ name: 'test', version: '0' });
    await mcp.connect(clientSide);
    const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['quorum_inbox', 'quorum_requests', 'quorum_send', 'quorum_status']);
    for (const [name, args] of [
      ['quorum_send', { to: ['QRM-0000-0000-0000'], text: 'hi' }],
      ['quorum_inbox', {}],
      ['quorum_status', {}],
      ['quorum_requests', {}],
    ] as const) {
      const result = await mcp.callTool({ name, arguments: args });
      expect((result.content as { text: string }[])[0]?.text).toContain('/quorum-id');
    }
    expect(PAIRING_INSTRUCTIONS).toContain('Only the human links sessions');
    await mcp.close();
  });
});

describe('quorum_requests: the person answers link requests in a dialog (D-21, INV-34)', () => {
  const request: LinkInfo = {
    id: 'QRM-7KD2-PX9F-M3TA',
    state: 'pending',
    tool: 'codex',
    machine: 'laptop-b',
    path: 'C:\\proj\\web',
    label: 'codex@web-2',
  };

  /** A session with one waiting request; records what the tool did. */
  const session = () => {
    const done: string[] = [];
    let links = [request];
    const client = {
      links: () => Promise.resolve({ id: 'QRM-0000-0000-0000', links }),
      allowLinks: (id: string) => {
        done.push(`allow ${id}`);
        links = [{ ...request, state: 'linked' }];
        return Promise.resolve({ links });
      },
      blockSession: (id: string) => {
        done.push(`block ${id}`);
        return Promise.resolve();
      },
    };
    const target = {
      client: client as unknown as QuorumClient,
      attachment: { workspaces: [] } as unknown as AttachmentInfo,
    };
    return { done, target };
  };

  /** Connect a client that shows dialogs (or not) and answers them with `answer`. */
  const open = async (
    target: PairedTarget,
    answer: ((message: string) => ElicitResult) | undefined,
    prefix: '/' | '$' = '/',
  ) => {
    const server = createPairingMcpServer({ resolve: () => Promise.resolve(target), prefix });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const mcp = new Client(
      { name: 'test', version: '0' },
      answer ? { capabilities: { elicitation: { form: {} } } } : {},
    );
    if (answer) {
      mcp.setRequestHandler(ElicitRequestSchema, (req) =>
        Promise.resolve(answer((req.params as { message: string }).message)),
      );
    }
    await mcp.connect(clientSide);
    const result = await mcp.callTool({ name: 'quorum_requests', arguments: {} });
    await mcp.close();
    return (result.content as { text: string }[])[0]?.text ?? '';
  };

  it('links when the person chooses Allow; the dialog names who asks', async () => {
    const { done, target } = session();
    const asked: string[] = [];
    const text = await open(target, (message) => {
      asked.push(message);
      return { action: 'accept', content: { answer: 'Allow' } };
    });
    expect(asked[0]).toContain(
      'codex@laptop-b - C:\\proj\\web - 2 (QRM-7KD2-PX9F-M3TA) wants to link with this session',
    );
    expect(done).toEqual(['allow QRM-7KD2-PX9F-M3TA']);
    expect(text).toContain('allowed QRM-7KD2-PX9F-M3TA');
  });

  it('blocks on Block; anything else (declined, dismissed, accepted with no choice) leaves it waiting', async () => {
    const blocked = session();
    await open(blocked.target, () => ({ action: 'accept', content: { answer: 'Block' } }));
    expect(blocked.done).toEqual(['block QRM-7KD2-PX9F-M3TA']);
    for (const reply of [
      { action: 'decline' },
      { action: 'cancel' },
      { action: 'accept', content: {} }, // a client that accepts dialogs by itself
      { action: 'accept', content: { answer: 'Not now' } },
    ] as ElicitResult[]) {
      const { done, target } = session();
      const text = await open(target, () => reply, '$');
      expect(done).toEqual([]);
      expect(text).toContain('still waiting (your human can type $quorum-allow');
    }
  });

  it('without dialogs, only says what the person can type', async () => {
    const { done, target } = session();
    const text = await open(target, undefined, '$');
    expect(done).toEqual([]);
    expect(text).toContain('type $quorum-allow QRM-7KD2-PX9F-M3TA to accept');
  });
});
