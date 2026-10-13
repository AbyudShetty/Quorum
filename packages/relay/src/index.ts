// The relay between machines on different networks (DECISIONS D-18, ARCHITECTURE §8.4).
export {
  type Arrival,
  arriveAccept,
  arriveConnect,
  arriveHome,
  checkHomeProof,
  CLOSE,
  CONN_ID,
  HOME_ID,
  homeProofMessage,
  MAX_CONNECTIONS_PER_HOME,
  MAX_FRAME_BYTES,
  onClose,
  onMessage,
  RELAY_PROTOCOL,
  type Room,
  type RoomSocket,
  type SocketMeta,
} from './router.js';
export { type Relay, type RelayOptions, startRelay } from './node.js';
