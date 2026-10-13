// Turning what an agent copied from a message back into an address (MESSAGE_SPEC §8): a sender
// line becomes a window label, `name@machine` an agent address. Shared by the adapters and the
// server (pairing routes `quorum_send` by it, D-20).
import { labelSlug } from './workspace-members.js';

/**
 * The address to send to, from what an agent was shown (MESSAGE_SPEC §1.1): a window's
 * `tool[@machine] - path - number` becomes its label (`claude@api-1`), `abyud (human)` becomes
 * `human:abyud`, a bare agent address gets its `agent:` prefix. A trailing `:` (as in the sender
 * line) is ignored. Anything else is passed as given (the server checks every address).
 */
export const recipientFor = (shown: string): string => {
  const given = shown.trim().replace(/\s*:$/, '');
  const window =
    /^([a-z][a-z0-9-]*)(?:@([a-z0-9][a-z0-9-]*))?(?:\s+-\s+([a-z0-9][a-z0-9-]*))?\s+-\s+(.+?)\s+-\s+([1-9][0-9]*)$/.exec(
      given,
    );
  if (window) {
    const [, tool = '', atMachine, dashMachine, path = '', number = ''] = window;
    const machine = atMachine ?? dashMachine;
    const folder = labelSlug(path.split(/[\\/]/).filter(Boolean).at(-1) ?? path);
    return `${tool}@${machine ? `${machine}-` : ''}${folder}-${number}`;
  }
  const human = /^([^\s()]+)\s*\(human\)$/.exec(given);
  if (human?.[1]) return `human:${human[1]}`;
  // A bare `name@machine` that is not a window label (`tool@folder-n`) is an agent.
  if (
    /^[a-z0-9][a-z0-9-]*@[a-z0-9][a-z0-9-]*$/.test(given) &&
    !/^(?:claude|codex|gemini|opencode|agent)@.+-[1-9][0-9]*$/.test(given)
  ) {
    return `agent:${given}`;
  }
  return given;
};
