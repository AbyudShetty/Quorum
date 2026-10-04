import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AttachmentInfo,
  createQuorumMcpServer,
  HEARTBEAT_INTERVAL_MS,
  Outbox,
  startHeartbeat,
  UnreachableError,
} from '../src/index.js';
import { connectAs, note, startWorld, type World } from './helpers.js';

let world: World | undefined;
afterEach(async () => {
  await world?.server.close();
  world = undefined;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const attachmentOf = (w: World): AttachmentInfo => ({
  attachment: 'at_test',
  agent: w.agent.address,
  workspaces: [w.workspace],
  vendor: 'claude-code',
  root: 'C:/work/api',
  wake: 'off',
  lease_enforcement: 'warn',
});

/** What a human sees for our agent in the workspace's agent list. */
const presenceOf = async (w: World, address: string) => {
  const human = await fetch(`${w.target.baseUrl}/v1/workspaces/${w.workspace}/agents`, {
    headers: { authorization: `Bearer ${w.human.token}` },
  });
  const list = (await human.json()) as {
    agents: { address: string; presence: string; status?: string }[];
  };
  return list.agents.find((a) => a.address === address);
};

describe('heartbeat (MESSAGE_SPEC §5.10)', () => {
  it('beats every 30 s by default', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
  });

  it('marks the agent online at once, keeps it online, and offline immediately on stop', async () => {
    world = await startWorld();
    expect(await presenceOf(world, world.agent.address)).toMatchObject({ presence: 'offline' });
    const heartbeat = startHeartbeat({
      client: await connectAs(world),
      attachment: attachmentOf(world),
      intervalMs: 40,
    });
    await sleep(120);
    expect(await presenceOf(world, world.agent.address)).toMatchObject({
      presence: 'online',
      status: 'idle',
    });
    await heartbeat.stop();
    expect(await presenceOf(world, world.agent.address)).toMatchObject({
      presence: 'offline',
      status: 'offline',
    });
    await sleep(120); // the timer is gone: nothing brings it back online
    expect(await presenceOf(world, world.agent.address)).toMatchObject({ presence: 'offline' });
  });

  it('can report a status change on demand, and stop is safe to call twice', async () => {
    world = await startWorld();
    const heartbeat = startHeartbeat({
      client: await connectAs(world),
      attachment: attachmentOf(world),
      intervalMs: 60_000,
    });
    await heartbeat.beat('working');
    expect(await presenceOf(world, world.agent.address)).toMatchObject({ status: 'working' });
    await Promise.all([heartbeat.stop(), heartbeat.stop()]);
    expect(await presenceOf(world, world.agent.address)).toMatchObject({ status: 'offline' });
  });

  it('never throws when the server is unreachable; errors go to onError', async () => {
    const errors: unknown[] = [];
    const heartbeat = startHeartbeat({
      client: { send: () => Promise.reject(new UnreachableError('down')) },
      attachment: { agent: 'agent:a@lab', workspaces: ['ws_1', 'ws_2'] },
      intervalMs: 20,
      onError: (e) => errors.push(e),
    });
    await sleep(70);
    await heartbeat.stop();
    expect(errors.length).toBeGreaterThanOrEqual(4); // two workspaces, several beats
    expect(errors.every((e) => e instanceof UnreachableError)).toBe(true);
  });

  it('does not hold a shutdown up for a server that never answers', async () => {
    const heartbeat = startHeartbeat({
      client: { send: () => new Promise(() => undefined) },
      attachment: { agent: 'agent:a@lab', workspaces: ['ws_1'] },
      intervalMs: 60_000,
    });
    const began = Date.now();
    await heartbeat.stop();
    expect(Date.now() - began).toBeLessThan(4000);
  }, 10_000);
});

describe('sender header shows the folder name (MESSAGE_SPEC §8)', () => {
  let mcp: Client | undefined;
  afterEach(async () => {
    await mcp?.close();
    mcp = undefined;
  });

  it('adds vendor and folder, but never a path', async () => {
    world = await startWorld();
    const sender = world.server.addAgent(
      'agent:web-agent@abhijna',
      [world.workspace],
      'codex',
      'web-app',
    );
    const server = createQuorumMcpServer({
      client: await connectAs(world),
      outbox: new Outbox(world.dataDir, 'at_test'),
      attachment: attachmentOf(world),
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    mcp = new Client({ name: 'test', version: '0' });
    await mcp.connect(a);

    await fetch(`${world.target.baseUrl}/v1/workspaces/${world.workspace}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${sender.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(note(world, sender.address, [world.agent.address], 'hello')),
    });
    const result = await mcp.callTool({ name: 'quorum_inbox', arguments: {} });
    const text = (result.content as { text: string }[])[0]?.text ?? '';
    expect(text).toContain(
      'from: agent:web-agent@abhijna (verified sender; vendor codex; folder "web-app")',
    );
    expect(text).not.toMatch(/[A-Za-z]:[\\/]/);
  });
});

describe('heartbeat ordering', () => {
  const start = async (w: World, intervalMs = 60_000) =>
    startHeartbeat({
      client: await connectAs(w),
      attachment: attachmentOf(w),
      intervalMs,
    });

  it('offline is always the last word, even when stopped right after starting', async () => {
    world = await startWorld();
    for (let i = 0; i < 20; i++) {
      const heartbeat = await start(world);
      await heartbeat.stop(); // the first "idle" beat may still be in flight
      expect(await presenceOf(world, world.agent.address)).toMatchObject({
        presence: 'offline',
        status: 'offline',
      });
    }
  });

  it('a status change right after starting is not overtaken by the first beat', async () => {
    world = await startWorld();
    for (let i = 0; i < 20; i++) {
      const heartbeat = await start(world);
      await heartbeat.beat('working');
      expect(await presenceOf(world, world.agent.address)).toMatchObject({ status: 'working' });
      await heartbeat.stop();
    }
  });

  it('ignores beats after stop (a late hook event must not bring the agent back online)', async () => {
    world = await startWorld();
    const heartbeat = await start(world);
    await heartbeat.stop();
    await heartbeat.beat('working');
    expect(await presenceOf(world, world.agent.address)).toMatchObject({ status: 'offline' });
  });

  it('does not pile beats up behind a slow server', async () => {
    let calls = 0;
    const heartbeat = startHeartbeat({
      client: {
        send: async () => {
          calls += 1;
          await sleep(150);
          return { seq: 1, duplicate: false };
        },
      },
      attachment: { agent: 'agent:a@lab', workspaces: ['ws_1'] },
      intervalMs: 10,
    });
    await sleep(120);
    expect(calls).toBeLessThanOrEqual(1); // the first beat is still in flight; no more were queued
    await heartbeat.stop();
  });
});
