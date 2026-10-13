// A self-signed X.509 certificate for the server's Ed25519 instance key (ARCHITECTURE §8.4). Through
// the relay, other machines run TLS 1.3 straight to this server; they trust the certificate only
// because its key's fingerprint matches the one in their invite code or server link (INV-24), so
// no certificate authority and no names are involved. Built by hand (DER) because Node can read
// certificates but not make them, and this one is tiny.
import { type KeyObject, sign } from 'node:crypto';

const length = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag: number, ...parts: Buffer[]): Buffer => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);
const integer = (bytes: Buffer) =>
  tlv(0x02, (bytes[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
/** RFC 5280: UTCTime up to 2049, GeneralizedTime from 2050. */
const time = (date: Date): Buffer => {
  const digits = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`))
    : tlv(0x18, Buffer.from(`${digits}Z`));
};
const ED25519 = sequence(tlv(0x06, Buffer.from([0x2b, 0x65, 0x70]))); // 1.3.101.112
const commonName = (name: string) =>
  sequence(
    tlv(0x31, sequence(tlv(0x06, Buffer.from([0x55, 0x04, 0x03])), tlv(0x0c, Buffer.from(name)))),
  );

/** PEM certificate for `privateKey`, valid from `from` for 100 years (identity is the key). */
export const selfSignedCertificate = (
  privateKey: KeyObject,
  publicKey: KeyObject,
  from: Date = new Date(),
): string => {
  const subject = commonName('quorum');
  const tbs = sequence(
    tlv(0xa0, integer(Buffer.from([2]))), // v3
    integer(Buffer.from([1])),
    ED25519,
    subject,
    sequence(time(from), time(new Date(from.getTime() + 100 * 365.25 * 86_400_000))),
    subject,
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const der = sequence(tbs, ED25519, tlv(0x03, Buffer.from([0]), sign(null, tbs, privateKey)));
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
};
