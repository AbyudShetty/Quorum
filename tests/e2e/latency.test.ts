// S5 (first version): delivery latency for ARCHITECTURE §15.3 "append → adapter receives, p95 < 20 ms".
// Measured here against the fake server, so it checks the harness and the client path, not the real
// server; point `baseUrl` at the real one at integration checkpoint IC2. Printed numbers are for
// humans; the assertion is deliberately loose (a shared CI runner must not make it flaky).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ulid } from '../contract/helpers.js';
import { type FakeServer, startFakeServer } from '../fakes/fake-server/fake-server.js';

const SAMPLES = 100;

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? NaN;

describe('S5 delivery latency (fake server)', () => {
  let server: FakeServer;
  let workspace: string;
  let sender: { address: string; token: string };
  let receiver: { address: string; token: string };

  beforeAll(async () => {
    server = await startFakeServer();
    workspace = server.createWorkspace('latency');
    sender = server.addAgent('agent:sender@lab', [workspace]);
    receiver = server.addAgent('agent:receiver@lab', [workspace]);
  });
  afterAll(async () => {
    await server.close();
  });

  const post = async (text: string): Promise<{ id: string; t0: number }> => {
    const id = `msg_${ulid()}`;
    const t0 = performance.now();
    const reply = await fetch(`${server.baseUrl}/v1/workspaces/${workspace}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sender.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        spec: 'quorum/1',
        id,
        workspace,
        from: sender.address,
        to: [receiver.address],
        type: 'note',
        type_version: 1,
        created_at: new Date().toISOString(),
        body: { text },
      }),
    });
    expect(reply.status).toBe(201);
    return { id, t0 };
  };

  it('append → push over the stream', async () => {
    const controller = new AbortController();
    const response = await fetch(`${server.baseUrl}/v1/workspaces/${workspace}/stream`, {
      headers: { authorization: `Bearer ${receiver.token}`, accept: 'text/event-stream' },
      signal: controller.signal,
    });
    const arrivals = new Map<string, number>();
    const reader = (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = block.split('\n').find((l) => l.startsWith('data:'));
          if (data)
            arrivals.set((JSON.parse(data.slice(5)) as { id: string }).id, performance.now());
        }
      }
    })().catch(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 50)); // let the stream attach
    const sent: { id: string; t0: number }[] = [];
    for (let i = 0; i < SAMPLES; i++) sent.push(await post(`m${String(i)}`));
    await new Promise((resolve) => setTimeout(resolve, 200));
    controller.abort();
    await reader;

    const latencies = sent.map((s) => (arrivals.get(s.id) ?? NaN) - s.t0).sort((a, b) => a - b);
    expect(latencies.every((l) => Number.isFinite(l))).toBe(true);
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    console.log(
      `S5 append→push over SSE (n=${String(SAMPLES)}): p50 ${p50.toFixed(1)} ms, p95 ${p95.toFixed(1)} ms (target p95 < 20 ms)`,
    );
    expect(p95).toBeLessThan(250);
  });

  it('append → visible in the inbox', async () => {
    const latencies: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const { id, t0 } = await post(`i${String(i)}`);
      const page = await fetch(
        `${server.baseUrl}/v1/workspaces/${workspace}/inbox?after=0&limit=500`,
        {
          headers: { authorization: `Bearer ${receiver.token}` },
        },
      );
      const body = (await page.json()) as { messages: { id: string }[] };
      expect(body.messages.some((m) => m.id === id)).toBe(true);
      latencies.push(performance.now() - t0);
    }
    latencies.sort((a, b) => a - b);
    console.log(
      `S5 append→inbox (n=${String(SAMPLES)}): p50 ${percentile(latencies, 50).toFixed(1)} ms, p95 ${percentile(latencies, 95).toFixed(1)} ms`,
    );
    expect(percentile(latencies, 95)).toBeLessThan(500);
  });
});
