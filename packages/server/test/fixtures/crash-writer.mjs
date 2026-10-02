// Child process for the crash test: appends chained events to an existing Quorum database as
// fast as it can, printing "committed <seq>" after each commit, until it is killed.
// Plain JavaScript on purpose (no build step); mirrors the EventStore append rules.
import { createHash, randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';

const [file, workspace] = process.argv.slice(2);
const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.pragma('busy_timeout = 5000');

// RFC 8785 for the plain JSON used here: sorted keys, JSON.stringify for scalars.
const canonical = (v) =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(',')}]`
    : v !== null && typeof v === 'object'
      ? `{${Object.keys(v)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
          .join(',')}}`
      : JSON.stringify(v);
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ulid = () => Array.from(randomBytes(26), (b) => CROCKFORD[b % 32]).join('');

const head = db.prepare(
  'SELECT seq, hash FROM events WHERE workspace = ? ORDER BY seq DESC LIMIT 1',
);
const insert = db.prepare(
  'INSERT INTO events (workspace, seq, ev_id, ts, actor, kind, payload, prev_hash, hash) VALUES (@workspace, @seq, @ev_id, @ts, @actor, @kind, @payload, @prev_hash, @hash)',
);
const appendOne = db.transaction(() => {
  const last = head.get(workspace);
  const event = {
    ev_id: `ev_${ulid()}`,
    workspace,
    seq: (last?.seq ?? 0) + 1,
    ts: new Date().toISOString(),
    actor: 'agent:crash-writer@test',
    kind: 'note.recorded',
    payload: { n: (last?.seq ?? 0) + 1, filler: 'x'.repeat(200) },
    prev_hash: last?.hash ?? sha256(`quorum/1 genesis ${workspace}`),
  };
  const hash = sha256(canonical(event));
  insert.run({ ...event, payload: JSON.stringify(event.payload), hash });
  return event.seq;
});

for (;;) {
  const seq = appendOne.immediate();
  process.stdout.write(`committed ${seq}\n`);
}
