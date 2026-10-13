import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createPairingMcpServer, PAIRING_INSTRUCTIONS } from '../src/index.js';

describe('MCP tools in pairing mode (D-20)', () => {
  it('tell a session that has not joined how to, for every tool', async () => {
    const server = createPairingMcpServer({ resolve: () => Promise.resolve(undefined) });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const mcp = new Client({ name: 'test', version: '0' });
    await mcp.connect(clientSide);
    const tools = (await mcp.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['quorum_inbox', 'quorum_send', 'quorum_status']);
    for (const [name, args] of [
      ['quorum_send', { to: ['QRM-0000-0000-0000'], text: 'hi' }],
      ['quorum_inbox', {}],
      ['quorum_status', {}],
    ] as const) {
      const result = await mcp.callTool({ name, arguments: args });
      expect((result.content as { text: string }[])[0]?.text).toContain('/quorum-id');
    }
    expect(PAIRING_INSTRUCTIONS).toContain('Only the human links sessions');
    await mcp.close();
  });
});
