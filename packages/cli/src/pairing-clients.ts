// A shared MCP process keeps verified clients, rather than spending unauthenticated health and
// hello requests on every wake scan. Each window owns a separate client (INV-7/24/34). The cache
// never resolves a caller: every tool invocation must first consume its own session proof.
import type { QuorumClient } from '@quorum/adapter-mcp';

export const createPairingClientCache = (
  connect: (attachment: string) => Promise<QuorumClient>,
  limit = 128,
) => {
  const clients = new Map<string, Promise<QuorumClient>>();
  return {
    get(attachment: string, window: string, server = ''): Promise<QuorumClient> {
      const key = JSON.stringify([attachment, window, server]);
      const existing = clients.get(key);
      if (existing) {
        clients.delete(key);
        clients.set(key, existing);
        return existing;
      }
      while (clients.size >= limit) {
        const oldest = clients.keys().next().value;
        if (oldest === undefined) break;
        clients.delete(oldest);
      }
      const pending = Promise.resolve()
        .then(() => connect(attachment))
        .then((client) => {
          client.session = window;
          return client;
        })
        .catch((error: unknown) => {
          if (clients.get(key) === pending) clients.delete(key);
          throw error;
        });
      clients.set(key, pending);
      return pending;
    },
  };
};
