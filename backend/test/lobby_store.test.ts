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

test('a championship race pins the bots, names the humans, and reverses the grid in race 3 (#273)', () => {
  const store = new LobbyStore();
  const { lobby, host } = store.createLobby('Host', {
    totalCars: 3,
    humanCars: 2,
    botCars: 1,
    season: true
  });
  const guest = store.joinLobby(lobby.lobbyId, 'Guest', undefined).player;
  store.startRace(lobby.lobbyId, host.playerToken);
  const season = lobby.season!;
  assert.deepEqual(season.drivers.map((d) => d.name).slice(0, 2), ['Host', 'Guest']);
  assert.equal(lobby.race!.seats[2]!.name, season.drivers[2]!.name);
  assert.equal(lobby.race!.seasonIndex, 0);

  // race 1 and 2 are scored (guest first, the bot second), then race 3 starts with the leader last
  for (const index of [0, 1]) {
    lobby.race!.engine.winnerCarId = guest.seatIndex + 1;
    lobby.status = 'FINISHED';
    store.recordSeasonResult(lobby.lobbyId, null);
    store.resetLobby(lobby.lobbyId, host.playerToken);
    store.startRace(lobby.lobbyId, host.playerToken);
    assert.equal(lobby.race!.seasonIndex, index + 1);
  }
  const leader = lobby.season!.races[0]!.result!.order[0]!;
  assert.ok(lobby.season!.races[2]!.reversedGrid);
  assert.equal(lobby.race!.log.grid?.[leader - 1], 2); // the leader of the table starts on the last slot
});
