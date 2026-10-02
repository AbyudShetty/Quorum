import { afterEach, describe, expect, it } from 'vitest';
import { Outbox, UnreachableError } from '../src/index.js';
import { connectAs, note, startWorld, type World } from './helpers.js';

let world: World | undefined;
afterEach(async () => {
  await world?.server.close();
  world = undefined;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

describe('Outbox (INV-20)', () => {
  it('keeps messages while the server is unreachable and delivers them in order later', async () => {
    world = await startWorld();
    const outbox = new Outbox(world.dataDir, 'at_test');
    const first = note(world, world.agent.address, [world.peer.address], 'first');
    await tick();
    const second = note(world, world.agent.address, [world.peer.address], 'second');
    await outbox.enqueue({ workspace: world.workspace, envelope: second });
    await outbox.enqueue({ workspace: world.workspace, envelope: first });

    const down = await outbox.flush(() => Promise.reject(new UnreachableError('down')));
    expect(down).toMatchObject({ sent: [], pending: 2 });
    expect(await outbox.size()).toBe(2);

    const client = await connectAs(world);
    const up = await outbox.flush((ws, env) => client.send(ws, env));
    expect(up.sent).toEqual([first.id, second.id]); // ULID order = creation order
    expect(await outbox.size()).toBe(0);
  });

  it('is safe to flush a message the server already has: it is stored once', async () => {
    world = await startWorld();
    const outbox = new Outbox(world.dataDir, 'at_test');
    const envelope = note(world, world.agent.address, [world.peer.address], 'once');
    const client = await connectAs(world);
    await client.send(world.workspace, envelope); // delivered, but we "crashed" before removing it
    await outbox.enqueue({ workspace: world.workspace, envelope });
    const result = await outbox.flush((ws, env) => client.send(ws, env));
    expect(result.sent).toEqual([envelope.id]);
    const peer = await fetch(`${world.target.baseUrl}/v1/workspaces/${world.workspace}/inbox`, {
      headers: { authorization: `Bearer ${world.peer.token}` },
    });
    const page = (await peer.json()) as { messages: { id: string }[] };
    expect(page.messages.filter((m) => m.id === envelope.id)).toHaveLength(1);
  });

  it('moves a message the server refuses for good to rejected/ and carries on', async () => {
    world = await startWorld();
    const outbox = new Outbox(world.dataDir, 'at_test');
    const bad = { ...note(world, world.agent.address, ['*'], 'x'), from: world.peer.address };
    await tick();
    const good = note(world, world.agent.address, ['*'], 'fine');
    await outbox.enqueue({ workspace: world.workspace, envelope: bad });
    await outbox.enqueue({ workspace: world.workspace, envelope: good });
    const client = await connectAs(world);
    const result = await outbox.flush((ws, env) => client.send(ws, env));
    expect(result.rejected.map((r) => r.id)).toEqual([bad.id]);
    expect(result.rejected[0]?.code).toBe('message.sender_mismatch');
    expect(result.sent).toEqual([good.id]);
    expect(await outbox.size()).toBe(0);
  });

  it('refuses to create the data directory itself (INV-25)', async () => {
    const outbox = new Outbox('C:\\definitely\\not\\here\\quorum', 'x');
    await expect(
      outbox.enqueue({ workspace: 'ws', envelope: { id: 'msg_1' } as never }),
    ).rejects.toThrow(/data directory/);
  });
});
