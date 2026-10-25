import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { BackendConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
import type { PublicLobby } from '../src/types.js';

const CONFIG: BackendConfig = {
  HOST: '127.0.0.1',
  PORT: 3001,
  CORS_ALLOWED_ORIGINS: '*',
  PLAYER_TOKEN_TTL_SECONDS: 86400,
  HOST_GRACE_SECONDS: 45
};

async function lobbyWithTwoSeats(t: { after: (fn: () => Promise<void>) => void }) {
  const app = await createApp(CONFIG, { logger: false, pingIntervalMs: 60 });
  await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    await app.close();
  });
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/lobbies',
    payload: { name: 'Host', settings: { totalCars: 2, humanCars: 2, botCars: 0 } }
  });
  const host = created.json() as { lobby: PublicLobby; playerToken: string };
  const joined = await app.inject({
    method: 'POST',
    url: `/api/v1/lobbies/${host.lobby.lobbyId}/join`,
    payload: { name: 'Guest' }
  });
  const guest = joined.json() as { playerToken: string };
  const port = (app.server.address() as net.AddressInfo).port;
  const path = (token: string) =>
    `/ws?lobbyId=${host.lobby.lobbyId}&playerToken=${encodeURIComponent(token)}`;
  const guestConnected = async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/lobbies/${host.lobby.lobbyId}?playerToken=${encodeURIComponent(host.playerToken)}`
    });
    const { lobby } = res.json() as { lobby: PublicLobby };
    return lobby.players.find((p) => !p.isHost)?.connected;
  };
  return { port, path, hostToken: host.playerToken, guestToken: guest.playerToken, guestConnected };
}

// A WebSocket client that never reads a frame, so it never answers a ping: a phone that dropped off the network.
function silentClient(port: number, path: string) {
  const socket = net.connect(port, '127.0.0.1');
  const upgraded = new Promise<void>((resolve) =>
    socket.on('data', (chunk) => String(chunk).includes('101') && resolve())
  );
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
  socket.write(
    `GET ${path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`
  );
  return { socket, upgraded, closed };
}

test('heartbeat: a socket that stops answering pings is dropped and its player shows as gone', async (t) => {
  const { port, path, guestToken, guestConnected } = await lobbyWithTwoSeats(t);
  const client = silentClient(port, path(guestToken));
  t.after(() => void client.socket.destroy());
  await client.upgraded;
  assert.equal(await guestConnected(), true);

  await Promise.race([client.closed, delay(2000).then(() => assert.fail('never dropped'))]);
  // The server's close handler runs a moment after the client sees the connection end.
  for (let i = 0; i < 50 && (await guestConnected()); i += 1) await delay(10);
  assert.equal(await guestConnected(), false);
});

test('heartbeat: a client that answers pings stays connected', async (t) => {
  const { port, path, guestToken, guestConnected } = await lobbyWithTwoSeats(t);
  // The built-in WebSocket answers pings by itself.
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path(guestToken)}`);
  t.after(() => ws.close());
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  await delay(400); // about six intervals
  assert.equal(ws.readyState, WebSocket.OPEN);
  assert.equal(await guestConnected(), true);
});
