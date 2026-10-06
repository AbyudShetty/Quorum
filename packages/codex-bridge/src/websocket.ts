// Just enough WebSocket (RFC 6455) to talk to the Codex daemon over a byte stream: the opening
// handshake, masked client text frames, and reading the daemon's frames. No dependency: the daemon
// is reached through `codex app-server proxy`, which pipes raw bytes, so a WebSocket library that
// wants to own the socket would not fit.
import { randomBytes } from 'node:crypto';

const CRLF = '\r\n';

/** The client's opening handshake. */
export const handshakeRequest = (): string =>
  [
    'GET / HTTP/1.1',
    'Host: localhost',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ].join(CRLF);

const header = (opcode: number, length: number, masked: boolean): Buffer => {
  const mask = masked ? 0x80 : 0;
  if (length < 126) return Buffer.from([0x80 | opcode, mask | length]);
  if (length < 65536) return Buffer.from([0x80 | opcode, mask | 126, length >> 8, length & 255]);
  const head = Buffer.alloc(10);
  head[0] = 0x80 | opcode;
  head[1] = mask | 127;
  head.writeBigUInt64BE(BigInt(length), 2);
  return head;
};

/** A client frame: always masked (RFC 6455 §5.3). Opcode 1 = text, 10 = pong, 8 = close. */
export const clientFrame = (payload: Buffer, opcode = 1): Buffer => {
  const key = randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = (payload[i] ?? 0) ^ (key[i % 4] ?? 0);
  return Buffer.concat([header(opcode, payload.length, true), key, masked]);
};

/** A server frame (unmasked); used by tests to play the daemon. */
export const serverFrame = (text: string, opcode = 1): Buffer => {
  const payload = Buffer.from(text, 'utf8');
  return Buffer.concat([header(opcode, payload.length, false), payload]);
};

export interface Frame {
  opcode: number;
  data: Buffer;
}

/**
 * Reads the daemon's side of the connection: first the HTTP `101` answer, then frames. Masked
 * frames (a client's, in tests) are unmasked too.
 */
export class FrameReader {
  #buffer = Buffer.alloc(0);
  #upgraded = false;
  /** Set when the handshake answer was not `101 Switching Protocols`. */
  refused: string | undefined;

  get upgraded(): boolean {
    return this.#upgraded;
  }

  /** Feed bytes; returns the complete frames now available. */
  push(chunk: Buffer): Frame[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (!this.#upgraded) {
      const end = this.#buffer.indexOf(CRLF + CRLF);
      if (end < 0) return [];
      const status = this.#buffer.subarray(0, end).toString('latin1').split(CRLF)[0] ?? '';
      this.#buffer = this.#buffer.subarray(end + 4);
      if (!/^HTTP\/1\.1 101\b/.test(status)) {
        this.refused = status;
        return [];
      }
      this.#upgraded = true;
    }
    const frames: Frame[] = [];
    for (;;) {
      const b = this.#buffer;
      if (b.length < 2) break;
      const opcode = (b[0] ?? 0) & 15;
      const masked = ((b[1] ?? 0) & 0x80) !== 0;
      let length = (b[1] ?? 0) & 127;
      let offset = 2;
      if (length === 126) {
        if (b.length < 4) break;
        length = b.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (b.length < 10) break;
        length = Number(b.readBigUInt64BE(2));
        offset = 10;
      }
      const keyLength = masked ? 4 : 0;
      if (b.length < offset + keyLength + length) break;
      const key = b.subarray(offset, offset + keyLength);
      const data = Buffer.from(b.subarray(offset + keyLength, offset + keyLength + length));
      if (masked)
        for (let i = 0; i < data.length; i++) data[i] = (data[i] ?? 0) ^ (key[i % 4] ?? 0);
      this.#buffer = b.subarray(offset + keyLength + length);
      frames.push({ opcode, data });
    }
    return frames;
  }
}
