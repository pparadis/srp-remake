import assert from 'node:assert/strict';
import test from 'node:test';
import { LobbyError, LobbyStore } from '../src/lobby_store.js';

function seatedLobby() {
  const store = new LobbyStore();
  const { lobby, host } = store.createLobby('Host', {
    totalCars: 2,
    humanCars: 2,
    botCars: 0
  });
  const guest = store.joinLobby(lobby.lobbyId, 'Guest', undefined).player;
  return { store, lobbyId: lobby.lobbyId, host, guest };
}

function statusOf(run: () => unknown): number | undefined {
  try {
    run();
  } catch (error) {
    return error instanceof LobbyError ? error.statusCode : undefined;
  }
  return undefined;
}

test('requirePlayer answers 404 for the lobby, then 401 for the token, and only a bad token calls the logger', () => {
  const { store, lobbyId, host, guest } = seatedLobby();
  let rejected = 0;
  const onInvalidToken = () => (rejected += 1);

  assert.equal(
    statusOf(() => store.requirePlayer('nowhere', host.playerToken, onInvalidToken)),
    404
  );
  assert.equal(rejected, 0);

  assert.equal(
    statusOf(() => store.requirePlayer(lobbyId, 'bad-token', onInvalidToken)),
    401
  );
  assert.equal(rejected, 1);

  assert.equal(store.requirePlayer(lobbyId, guest.playerToken, onInvalidToken).player, guest);
  assert.equal(rejected, 1);
});

test("requireHost answers 404, 401, then 403 with the caller's message; a bad token is never a 403", () => {
  const { store, lobbyId, host, guest } = seatedLobby();

  assert.equal(
    statusOf(() => store.requireHost('nowhere', host.playerToken, 'x')),
    404
  );
  assert.equal(
    statusOf(() => store.requireHost(lobbyId, 'bad-token', 'x')),
    401
  );
  assert.throws(
    () => store.requireHost(lobbyId, guest.playerToken, 'Only host can do this.'),
    (error) =>
      error instanceof LobbyError &&
      error.statusCode === 403 &&
      error.message === 'Only host can do this.'
  );
  assert.equal(store.requireHost(lobbyId, host.playerToken, 'x').lobbyId, lobbyId);
});
