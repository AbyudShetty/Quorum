import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type FakeServer, startFakeServer } from '../../../tests/fakes/fake-server/fake-server.js';
import {
  type AgentResult,
  type FleetManifest,
  formatSummary,
  parseManifest,
  passed,
  prng,
  startBarrier,
  runFleetCli,
  runLocalFleet,
  summarize,
} from '../src/index.js';

const result = (overrides: Partial<AgentResult> & { address: string }): AgentResult => ({
  sent: [],
  received: [],
  duplicates: 0,
  errors: {},
  ...overrides,
});

describe('summarize', () => {
  const a = 'agent:a@lab';
  const b = 'agent:b@lab';

  it('counts a clean exchange as delivered, with latency percentiles', () => {
    const s = summarize([
      result({ address: a, sent: [{ id: 'm1', to: b, at: 0 }] }),
      result({ address: b, received: [{ id: 'm1', from: a, latencyMs: 12 }] }),
    ]);
    expect(s).toMatchObject({ agents: 2, sent: 1, received: 1, lost: 0, misdelivered: 0 });
    expect(s.latencyMs.p50).toBe(12);
    expect(passed(s)).toBe(true);
  });

  it('counts a message the addressee never saw as lost', () => {
    const s = summarize([
      result({ address: a, sent: [{ id: 'm1', to: b, at: 0 }] }),
      result({ address: b }),
    ]);
    expect(s.lost).toBe(1);
    expect(passed(s)).toBe(false);
  });

  it('counts delivery to the wrong agent (INV-7 / inbox isolation)', () => {
    const c = 'agent:c@lab';
    const s = summarize([
      result({ address: a, sent: [{ id: 'm1', to: b, at: 0 }] }),
      result({ address: b, received: [{ id: 'm1', from: a, latencyMs: 1 }] }),
      result({ address: c, received: [{ id: 'm1', from: a, latencyMs: 1 }] }),
    ]);
    expect(s.misdelivered).toBe(1);
    expect(passed(s)).toBe(false);
  });

  it('adds up errors and duplicates, and any error fails the run', () => {
    const s = summarize([
      result({ address: a, errors: { unreachable: 2 }, duplicates: 1 }),
      result({ address: b, errors: { unreachable: 1, 'message.invalid': 1 } }),
    ]);
    expect(s.errors).toEqual({ unreachable: 3, 'message.invalid': 1 });
    expect(s.duplicates).toBe(1);
    expect(passed(s)).toBe(false);
  });

  it('prints a readable report', () => {
    const text = formatSummary(summarize([result({ address: a }), result({ address: b })]));
    expect(text).toContain('agents 2');
    expect(text).toContain('errors none');
  });
});

describe('prng', () => {
  it('is repeatable and stays in [0, 1)', () => {
    const one = prng(7);
    const two = prng(7);
    const values = Array.from({ length: 100 }, () => one());
    expect(values).toEqual(Array.from({ length: 100 }, () => two()));
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
  });
});

describe('parseManifest', () => {
  it('accepts a manifest and rejects broken ones', () => {
    const good = {
      baseUrl: 'http://server:8787',
      publicKey: 'k',
      instanceId: 'i',
      workspace: 'ws',
      agents: [
        { address: 'a', token: 't', refreshToken: 'r' },
        { address: 'b', token: 't', refreshToken: 'r' },
      ],
    };
    expect(parseManifest(good).agents).toHaveLength(2);
    expect(() => parseManifest({ ...good, agents: [good.agents[0]] })).toThrow(/two agents/);
    expect(() => parseManifest({ ...good, workspace: '' })).toThrow(/workspace/);
    expect(() => parseManifest(null)).toThrow();
  });
});

describe('fleet against the fake server', () => {
  let server: FakeServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const provision = async (count: number): Promise<FleetManifest> => {
    server = await startFakeServer();
    const workspace = server.createWorkspace('fleet');
    const agents = Array.from({ length: count }, (_, i) => {
      const address = `agent:fleet-${String(i + 1).padStart(3, '0')}@lab`;
      const { token, refreshToken } = server?.addAgent(address, [workspace]) ?? {
        token: '',
        refreshToken: '',
      };
      return { address, token, refreshToken };
    });
    return {
      baseUrl: server.baseUrl,
      publicKey: server.publicKey,
      instanceId: server.instanceId,
      workspace,
      agents,
    };
  };

  it('20 agents exchange messages with nothing lost, duplicated to the wrong agent, or failed', async () => {
    const manifest = await provision(20);
    const results = await runLocalFleet(manifest, {
      ratePerSecond: 5,
      durationMs: 2000,
      drainMs: 1000,
      pollIntervalMs: 50,
      seed: 3,
    });
    const summary = summarize(results);
    console.log(`fleet n=20\n${formatSummary(summary)}`);
    expect(summary.sent).toBeGreaterThan(100);
    expect(summary).toMatchObject({ lost: 0, misdelivered: 0, errors: {} });
    expect(summary.received).toBe(summary.sent);
    expect(passed(summary)).toBe(true);
  }, 30_000);

  it('is repeatable: the same seed picks the same peers', async () => {
    const manifest = await provision(4);
    const run = () =>
      runLocalFleet(manifest, { ratePerSecond: 20, durationMs: 300, drainMs: 300, seed: 9 });
    const targets = (rs: AgentResult[]) => rs.map((r) => r.sent.slice(0, 3).map((s) => s.to));
    const first = await run();
    const second = await run();
    expect(targets(second)).toEqual(targets(first));
  }, 30_000);

  it('an outage mid-run loses nothing: the outbox holds messages until the server is back (INV-20)', async () => {
    const manifest = await provision(8);
    const fake = server as FakeServer;
    const run = runLocalFleet(manifest, {
      ratePerSecond: 5,
      durationMs: 4000,
      drainMs: 3000,
      pollIntervalMs: 50,
      seed: 5,
    });
    setTimeout(() => {
      fake.setOutage('down');
    }, 1000);
    setTimeout(() => {
      fake.setOutage('off');
    }, 2500);
    const summary = summarize(await run);
    console.log(`fleet outage n=8
${formatSummary(summary)}`);
    expect(summary.errors.unreachable ?? 0).toBeGreaterThan(0); // the outage really happened
    expect(summary).toMatchObject({ lost: 0, unsent: 0, misdelivered: 0 });
    expect(summary.received).toBe(summary.sent);
    expect(summary.latencyMs.max).toBeGreaterThan(1000); // some mail waited out the outage
    expect(passed(summary, { allowUnreachable: true })).toBe(true);
    expect(passed(summary)).toBe(false); // without the allowance, the errors are reported
  }, 30_000);

  it('a server that never comes back is reported as unsent and lost, not hidden', async () => {
    const manifest = await provision(3);
    const fake = server as FakeServer;
    const run = runLocalFleet(manifest, {
      ratePerSecond: 5,
      durationMs: 1500,
      drainMs: 500,
      pollIntervalMs: 50,
      seed: 6,
    });
    setTimeout(() => {
      fake.setOutage('down');
    }, 300);
    const summary = summarize(await run);
    expect(summary.unsent).toBeGreaterThan(0);
    expect(passed(summary, { allowUnreachable: true })).toBe(false);
  }, 30_000);

  it('container mode: replicas claim distinct indexes, then the report passes', async () => {
    const manifest = await provision(3);
    const dir = await mkdtemp(join(tmpdir(), 'quorum-fleet-'));
    await writeFile(join(dir, 'fleet.json'), JSON.stringify(manifest));
    const env = {
      FLEET_MANIFEST: join(dir, 'fleet.json'),
      FLEET_DURATION_S: '1',
      FLEET_DRAIN_S: '1',
      FLEET_RATE: '5',
      FLEET_POLL_MS: '50',
      FLEET_AGENTS: '3',
    };
    const lines: string[] = [];
    const codes = await Promise.all(
      [1, 2, 3].map(() => runFleetCli(['agent'], env, (l) => lines.push(l))),
    );
    expect(codes).toEqual([0, 0, 0]);
    expect((await readdir(join(dir, 'claims'))).sort()).toEqual(['claim-0', 'claim-1', 'claim-2']);
    expect(new Set(lines.map((l) => /^agent (\S+):/.exec(l)?.[1])).size).toBe(3); // three different agents

    const report: string[] = [];
    expect(await runFleetCli(['report'], env, (l) => report.push(l))).toBe(0);
    expect(report.join('\n')).toContain('PASS');
  }, 30_000);

  it('the report fails when a replica never produced a result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quorum-fleet-'));
    const env = {
      FLEET_MANIFEST: join(dir, 'fleet.json'),
      FLEET_AGENTS: '2',
      FLEET_REPORT_WAIT_S: '1', // do not wait the full default for a replica that will never come
    };
    await writeFile(join(dir, 'x'), '');
    const out: string[] = [];
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'results'));
    await writeFile(join(dir, 'results', '0000.json'), JSON.stringify(result({ address: 'a' })));
    expect(await runFleetCli(['report'], env, (l) => out.push(l))).toBe(1);
    expect(out.join('\n')).toContain('MISSING RESULTS');
  });
});

describe('startBarrier', () => {
  it('releases every agent together, and only once all have arrived', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quorum-barrier-'));
    const released: number[] = [];
    const arrive = async (index: number, delayMs: number) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      await startBarrier(dir, index, 3, 10);
      released.push(Date.now());
    };
    const began = Date.now();
    await Promise.all([arrive(0, 0), arrive(1, 150), arrive(2, 300)]);
    expect(Math.min(...released) - began).toBeGreaterThanOrEqual(250); // nobody left before the last arrived
    expect(Math.max(...released) - Math.min(...released)).toBeLessThan(200);
  });

  it('fails instead of waiting forever when an agent never shows up', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'quorum-barrier-'));
    await expect(startBarrier(dir, 0, 2, 0.3)).rejects.toThrow(/not all 2 agents/);
  });
});
