import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

// An anonymous device identity (#194): `<id>.<signature>`, the id a random UUID and the signature an HMAC of it. No
// account and no table: the server only checks that it signed the id. Clearing the browser's storage makes a new device,
// so this raises the cost of abusing the public history, it does not stop it.

function sign(secret: string, id: string): string {
  return createHmac('sha256', secret).update(id).digest('base64url');
}

export function mintDeviceToken(secret: string): string {
  const id = randomUUID();
  return `${id}.${sign(secret, id)}`;
}

/** The device id when this server signed the token, null otherwise. */
export function verifyDeviceToken(secret: string, token: string): string | null {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const id = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(secret, id));
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : null;
}

/** What the history keeps of a device: enough to count its races, not enough to recover the id. */
export function deviceHash(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 16);
}
