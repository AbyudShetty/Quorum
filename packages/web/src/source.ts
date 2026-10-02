// Where the timeline gets its data. The real server can implement `TimelineSource` straight on its
// message projection; `fromApi` builds one from the public /v1 API (workspace list + the human's
// export of the event log), so the UI also works against the fake server and any other /v1 server.

export interface TimelineMessage {
  seq: number;
  id: string;
  from: string;
  to: string[];
  type: string;
  created_at: string;
  thread?: string;
  refs?: string[];
  /** Untrusted. Only ever rendered through escaping templates. */
  body: unknown;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
}

export interface TimelineSource {
  workspaces(): Promise<WorkspaceSummary[]>;
  /** The newest `limit` messages of a workspace, oldest first. */
  messages(workspace: string, limit: number): Promise<TimelineMessage[]>;
}

/** The part of an API client `fromApi` needs (structural: satisfied by QuorumClient). */
export interface ExportApi {
  call(method: string, path: string): Promise<{ body: unknown }>;
  exportEvents(workspace: string): Promise<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

/** Read `message.accepted` events from a JSON Lines export; anything else is skipped. */
export const messagesFromExport = (jsonl: string): TimelineMessage[] => {
  const out: TimelineMessage[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event) || event.kind !== 'message.accepted' || !isRecord(event.payload)) continue;
    const envelope = event.payload.envelope;
    if (!isRecord(envelope) || typeof event.seq !== 'number') continue;
    out.push({
      seq: event.seq,
      id: str(envelope.id),
      from: str(envelope.from, 'unknown'),
      to: Array.isArray(envelope.to)
        ? envelope.to.filter((t): t is string => typeof t === 'string')
        : [],
      type: str(envelope.type, 'unknown'),
      created_at: str(envelope.created_at, str(event.ts)),
      ...(typeof envelope.thread === 'string' ? { thread: envelope.thread } : {}),
      ...(Array.isArray(envelope.refs)
        ? { refs: envelope.refs.filter((r): r is string => typeof r === 'string') }
        : {}),
      body: envelope.body,
    });
  }
  return out;
};

export const fromApi = (api: ExportApi): TimelineSource => ({
  async workspaces() {
    const reply = await api.call('GET', '/v1/workspaces');
    const list =
      isRecord(reply.body) && Array.isArray(reply.body.workspaces) ? reply.body.workspaces : [];
    return list.filter(isRecord).map((w) => ({ id: str(w.id), name: str(w.name) }));
  },
  async messages(workspace, limit) {
    return messagesFromExport(await api.exportEvents(workspace)).slice(-limit);
  },
});
