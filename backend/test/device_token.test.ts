import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceHash, mintDeviceToken, verifyDeviceToken } from '../src/device_token.js';

const SECRET = 'a-secret-of-at-least-32-characters!';

test('a minted token verifies to its id, and each token is another device', () => {
  const token = mintDeviceToken(SECRET);
  const id = verifyDeviceToken(SECRET, token);
  assert.ok(id);
  assert.ok(token.startsWith(`${id}.`));
  assert.notEqual(verifyDeviceToken(SECRET, mintDeviceToken(SECRET)), id);
});

test('a changed id or signature, another secret and garbage are refused', () => {
  const token = mintDeviceToken(SECRET);
  const [id, signature] = token.split('.') as [string, string];
  assert.equal(verifyDeviceToken(SECRET, `${id}x.${signature}`), null);
  assert.equal(verifyDeviceToken(SECRET, `${id}.${signature.slice(1)}`), null);
  assert.equal(verifyDeviceToken(SECRET, `${id}.`), null);
  assert.equal(verifyDeviceToken('another-secret-of-32-characters!!', token), null);
  for (const garbage of ['', 'nope', '.', '..', `${id}`]) {
    assert.equal(verifyDeviceToken(SECRET, garbage), null);
  }
});

test('the stored hash is short, stable and not the id', () => {
  const id = verifyDeviceToken(SECRET, mintDeviceToken(SECRET))!;
  assert.match(deviceHash(id), /^[0-9a-f]{16}$/);
  assert.equal(deviceHash(id), deviceHash(id));
  assert.ok(!id.includes(deviceHash(id)));
});
