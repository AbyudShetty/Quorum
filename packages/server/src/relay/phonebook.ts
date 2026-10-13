// Looking a Quorum ID up in the relay's phone book (DECISIONS D-20, PAIRING.md §3). The answer is
// only believed if the home key fingerprint and salt it gives really produce the ID: a relay that
// points an ID elsewhere is caught here, before anything is sent to that address.
import { checkQuorumId } from '@quorum/core';
import { RelayError } from '@quorum/local';

/** Where a Quorum ID lives: its home's key fingerprint and the salt the ID was made with. */
export interface IdLocation {
  home: string;
  salt: string;
}

/** The relay's HTTP address for its WebSocket address (wss → https, ws → http). */
const httpOf = (relay: string): string => relay.replace(/^ws/, 'http');

/** Where `id` lives, checked; undefined when there is no such ID. */
export const lookupQuorumId = async (
  relay: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IdLocation | undefined> => {
  let response: Response;
  try {
    response = await fetchImpl(`${httpOf(relay)}/v1/lookup/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new RelayError(`Cannot reach the relay at ${relay}: ${String(error)}`);
  }
  if (response.status === 404) return undefined;
  if (response.status === 429) {
    throw new RelayError('Too many ID lookups from here; try again in a minute.', 429);
  }
  if (response.status !== 200) {
    throw new RelayError(
      `The relay at ${relay} could not look up ${id} (${String(response.status)}).`,
    );
  }
  const entry = (await response.json().catch(() => undefined)) as Partial<IdLocation> | undefined;
  if (
    typeof entry?.home !== 'string' ||
    typeof entry.salt !== 'string' ||
    !checkQuorumId(id, entry.home, entry.salt)
  ) {
    throw new RelayError(
      `The relay at ${relay} gave an answer for ${id} that does not match the ID: it may be compromised. Nothing was sent.`,
    );
  }
  return { home: entry.home, salt: entry.salt };
};
