import assert from 'node:assert/strict';
import test from 'node:test';
import type { BackendConfig } from '../src/config.js';
import { LobbyStore } from '../src/lobby_store.js';
import { createApp, MAX_DEDUPED_RESULTS } from '../src/server.js';
import type { RaceState } from '../src/types.js';
import { legalMove, playRaceToEnd, readLobby } from './helpers.js';

const TEST_CONFIG: BackendConfig = {
  HOST: '127.0.0.1',
  PORT: 3001,
  CORS_ALLOWED_ORIGINS: '*',
  PLAYER_TOKEN_TTL_SECONDS: 86400
};

async function startRace(
  settings: Record<string, number> = { totalCars: 2, humanCars: 1, botCars: 1, raceLaps: 3 }
) {
  const app = await createApp(TEST_CONFIG, { logger: false });
  const createdRes = await app.inject({
    method: 'POST',
    url: '/api/v1/lobbies',
    payload: { name: 'Host', settings }
  });
  const created = createdRes.json() as { lobby: { lobbyId: string }; playerToken: string };
  const startRes = await app.inject({
    method: 'POST',
    url: `/api/v1/lobbies/${created.lobby.lobbyId}/start`,
    payload: { playerToken: created.playerToken }
  });
  assert.equal(startRes.statusCode, 200);
  const raceState = (startRes.json() as { lobby: { raceState: RaceState } }).lobby.raceState;
  const submit = (action: unknown, clientCommandId: string, revision = 0) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/lobbies/${created.lobby.lobbyId}/turns`,
      payload: { playerToken: created.playerToken, clientCommandId, revision, action }
    });
  return { app, lobbyId: created.lobby.lobbyId, token: created.playerToken, raceState, submit };
}

test('rejects illegal actions without touching the race', async (t) => {
  const { app, lobbyId, token, raceState, submit } = await startRace();
  t.after(() => app.close());
  const hostSetup = raceState.cars[0]!.setup;
  const legal = legalMove(raceState);
  assert.equal(legal.type, 'move');

  const cases: Array<[string, unknown, string]> = [
    ['unreachable cell', { type: 'move', targetCellId: 'Z16_L3_00' }, 'invalid_target'],
    ['unknown cell', { type: 'move', targetCellId: 'nowhere' }, 'invalid_target'],
    ['skip while moves are available', { type: 'skip' }, 'moves_available'],
    [
      'pit on a normal cell',
      {
        type: 'pit',
        targetCellId: legal.type === 'move' ? legal.targetCellId : '',
        setup: hostSetup
      },
      'not_pit_box'
    ]
  ];
  for (const [label, action, reason] of cases) {
    const res = await submit(action, `bad-${label}`);
    assert.equal(res.statusCode, 409, label);
    assert.deepEqual(
      { ok: false, error: 'invalid_action', reason, revision: 0 },
      (({ ok, error, reason: r, revision }) => ({ ok, error, reason: r, revision }))(res.json())
    );
  }

  // Nothing moved, no turn was consumed, and the host can still play a legal move.
  const lobby = await readLobby(app, lobbyId, token);
  assert.equal(lobby.revision, 0);
  assert.equal(lobby.raceState.turnIndex, 0);
  assert.equal(lobby.raceState.activeSeatIndex, 0);
  assert.deepEqual(lobby.raceState.cars, raceState.cars);
  assert.equal((await submit(legal, 'good-move')).statusCode, 200);
});

test('a rejected action is deduped: the same command id replays the same rejection', async (t) => {
  const { app, submit } = await startRace();
  t.after(() => app.close());

  const first = await submit({ type: 'move', targetCellId: 'Z16_L3_00' }, 'same-id');
  const second = await submit({ type: 'move', targetCellId: 'Z16_L3_00' }, 'same-id');

  assert.equal(first.statusCode, 409);
  assert.deepEqual(second.json(), first.json());
});

test('malformed turn payloads are a 400, not a server error', async (t) => {
  const { app, raceState, submit } = await startRace();
  t.after(() => app.close());
  const target = legalMove(raceState);
  assert.equal(target.type, 'move');

  const noSetup = await submit({ type: 'pit', targetCellId: 'Z02_L0_00' }, 'no-setup');
  const noTarget = await submit({ type: 'move' }, 'no-target');
  const badType = await submit({ type: 'teleport', targetCellId: 'Z02_L1_00' }, 'bad-type');

  assert.deepEqual([noSetup.statusCode, noTarget.statusCode, badType.statusCode], [400, 400, 400]);
  assert.equal((noSetup.json() as { error: string }).error, 'invalid_request');
});

test('rejects an unknown track when creating or configuring a lobby', async (t) => {
  const app = await createApp(TEST_CONFIG, { logger: false });
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/lobbies',
    payload: { name: 'Host', settings: { trackId: '../../etc/passwd' } }
  });

  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /Unknown trackId/);
});

test('the server plays the race to a winner and then closes it', async (t) => {
  const { app, lobbyId, token, submit } = await startRace({
    totalCars: 2,
    humanCars: 1,
    botCars: 1,
    raceLaps: 1
  });
  t.after(() => app.close());

  const finished = await playRaceToEnd(app, lobbyId, token);

  const race = finished.raceState;
  assert.equal(finished.status, 'FINISHED');
  assert.equal(finished.terminationReason, 'race_finished');
  assert.notEqual(race.winnerCarId, null);
  assert.ok((race.cars.find((car) => car.carId === race.winnerCarId)?.lapCount ?? 0) >= 1);
  const late = await submit({ type: 'skip' }, 'after-finish', finished.revision);
  assert.equal(late.statusCode, 409);
  assert.equal((late.json() as { error: string }).error, 'lobby_not_in_race');
});

test('a pit stop needs a legal setup; a valid one refills the car and costs the next turn', async (t) => {
  const store = new LobbyStore();
  const app = await createApp(TEST_CONFIG, { logger: false, lobbyStore: store });
  t.after(() => app.close());
  const createdRes = await app.inject({
    method: 'POST',
    url: '/api/v1/lobbies',
    payload: { name: 'Host', settings: { totalCars: 2, humanCars: 1, botCars: 1, raceLaps: 3 } }
  });
  const created = createdRes.json() as { lobby: { lobbyId: string }; playerToken: string };
  const { lobbyId } = created.lobby;
  await app.inject({
    method: 'POST',
    url: `/api/v1/lobbies/${lobbyId}/start`,
    payload: { playerToken: created.playerToken }
  });
  // Park the host's worn car in the pit lane, one step before the first pit box.
  const hostCar = store.getLobby(lobbyId)!.race!.engine.cars[0]!;
  Object.assign(hostCar, { cellId: 'Z01_L0_00', tire: 20, fuel: 25 });
  const setup = {
    compound: 'hard',
    psi: { fl: 22, fr: 22, rl: 20, rr: 20 },
    wing: 'medium' as const
  };
  const pit = (payloadSetup: unknown, clientCommandId: string, revision: number) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/lobbies/${lobbyId}/turns`,
      payload: {
        playerToken: created.playerToken,
        clientCommandId,
        revision,
        action: { type: 'pit', targetCellId: 'Z02_L0_00', setup: payloadSetup }
      }
    });

  const badSetup = await pit({ ...setup, psi: { ...setup.psi, fl: 99 } }, 'pit-bad', 0);
  assert.equal(badSetup.statusCode, 409);
  assert.equal((badSetup.json() as { reason: string }).reason, 'invalid_setup');
  assert.equal(hostCar.tire, 20);

  const ok = await pit(setup, 'pit-ok', 0);
  assert.equal(ok.statusCode, 200);
  const lobby = await readLobby(app, lobbyId, created.playerToken);
  const car = lobby.raceState.cars[0]!;
  assert.deepEqual(
    [car.cellId, car.tire, car.fuel, car.pitServiced, car.setup.compound, car.setup.wing],
    ['Z02_L0_00', 100, 100, true, 'hard', 'medium']
  );
  // The stop cost the host a turn: the bot played twice before it was the host's again.
  assert.equal(lobby.revision, 3);
  assert.equal(lobby.raceState.activeSeatIndex, 0);
  assert.deepEqual([car.state, car.pitTurnsRemaining, car.pitExitBoost], ['ACTIVE', 0, true]);
});

test('reset: only the host may reset, only a naturally finished lobby, and a reset lobby races again', async (t) => {
  const store = new LobbyStore();
  const app = await createApp(TEST_CONFIG, { logger: false, lobbyStore: store });
  t.after(() => app.close());
  const post = async (lobbyId: string, action: string, playerToken: string) =>
    app.inject({
      method: 'POST',
      url: `/api/v1/lobbies/${lobbyId}/${action}`,
      payload: { playerToken }
    });
  const create = async () =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/v1/lobbies',
        payload: { name: 'Host', settings: { totalCars: 3, humanCars: 2, botCars: 1, raceLaps: 1 } }
      })
    ).json() as { lobby: { lobbyId: string }; playerToken: string };

  const { lobby, playerToken } = await create();
  const id = lobby.lobbyId;
  const guest = (
    await app.inject({
      method: 'POST',
      url: `/api/v1/lobbies/${id}/join`,
      payload: { name: 'Guest' }
    })
  ).json() as { playerToken: string };

  // WAITING and IN_RACE lobbies cannot be reset
  assert.equal((await post(id, 'reset', playerToken)).statusCode, 409);
  await post(id, 'start', playerToken);
  assert.equal((await post(id, 'reset', playerToken)).statusCode, 409);

  // The token and the host come before the state (#208): a stranger or a guest learns nothing about the race.
  for (const action of ['start', 'reset']) {
    assert.equal(
      (await post(id, action, 'bogus')).statusCode,
      401,
      `${action}, in race, bad token`
    );
    assert.equal(
      (await post(id, action, guest.playerToken)).statusCode,
      403,
      `${action}, in race, guest`
    );
  }
  const settings = (playerToken: string) =>
    app.inject({
      method: 'PATCH',
      url: `/api/v1/lobbies/${id}/settings`,
      payload: { playerToken, settings: { raceLaps: 2 } }
    });
  assert.equal((await settings('bogus')).statusCode, 401);
  assert.equal((await settings(guest.playerToken)).statusCode, 403);
  assert.equal((await settings(playerToken)).statusCode, 409);

  // Finish the race by hand (two humans alternate; seat 2 is a bot played by the server).
  const tokens = [playerToken, guest.playerToken];
  for (let i = 0; i < 600; i += 1) {
    const state = await readLobby(app, id, playerToken);
    if (state.status === 'FINISHED') break;
    await app.inject({
      method: 'POST',
      url: `/api/v1/lobbies/${id}/turns`,
      payload: {
        playerToken: tokens[state.raceState.activeSeatIndex],
        clientCommandId: `one-${i}`,
        revision: state.revision,
        action: legalMove(state.raceState)
      }
    });
  }
  const finished = await readLobby(app, id, playerToken);
  assert.equal(finished.status, 'FINISHED');

  assert.equal((await post(id, 'reset', guest.playerToken)).statusCode, 403);
  assert.equal((await post(id, 'reset', 'bogus')).statusCode, 401);
  assert.equal((await post(id, 'start', playerToken)).statusCode, 409);

  const reset = await post(id, 'reset', playerToken);
  assert.equal(reset.statusCode, 200);
  const waiting = await readLobby(app, id, playerToken);
  assert.equal(waiting.status, 'WAITING');
  assert.equal(waiting.revision, finished.revision + 1);
  assert.equal(waiting.terminationReason, undefined);
  assert.equal(waiting.raceState, undefined);
  // guest token still works, and a second reset is refused
  assert.equal((await readLobby(app, id, guest.playerToken)).status, 'WAITING');
  assert.equal((await post(id, 'reset', playerToken)).statusCode, 409);

  // a fresh race on the same lobby: new engine state, no winner, zero laps
  assert.equal((await post(id, 'start', playerToken)).statusCode, 200);
  const second = await readLobby(app, id, playerToken);
  assert.equal(second.status, 'IN_RACE');
  assert.equal(second.raceState.winnerCarId, null);
  assert.ok(second.raceState.cars.every((car) => (car.lapCount ?? 0) === 0));

  // a terminated lobby stays dead
  const dead = await create();
  store.terminateLobby(dead.lobby.lobbyId, 'host_disconnected');
  // (closing revokes every token, so the host is turned away at the token check)
  const refused = await post(dead.lobby.lobbyId, 'reset', dead.playerToken);
  assert.equal(refused.statusCode, 401);
  assert.equal(store.getLobby(dead.lobby.lobbyId)?.status, 'FINISHED');
});

test('a grid setup changes the car for free, keeps the turn, and is refused after the first move', async (t) => {
  const { app, token, lobbyId, raceState, submit } = await startRace();
  t.after(() => app.close());
  const setup = { compound: 'soft', psi: { fl: 32, fr: 32, rl: 32, rr: 32 }, wing: 'low' };

  const bad = await submit({ type: 'setup', setup: { ...setup, wing: 'huge' } }, 'setup-bad');
  assert.equal(bad.statusCode, 400);

  const ok = await submit({ type: 'setup', setup }, 'setup-ok');
  assert.equal(ok.statusCode, 200);
  const afterSetup = await readLobby(app, lobbyId, token);
  assert.equal(afterSetup.raceState.cars[0]!.setup.wing, 'low');
  // Not a turn: the host still plays, the bot has not moved.
  assert.equal(afterSetup.raceState.activeSeatIndex ?? 0, 0);
  assert.equal(afterSetup.raceState.cars[1]!.cellId, raceState.cars[1]!.cellId);
  // ...and it does not count as a turn: the turn index (what the timer and the AFK check read) stays put.
  assert.equal(afterSetup.raceState.turnIndex, raceState.turnIndex);
  assert.equal(afterSetup.raceState.cars[0]!.setupLocked ?? false, false);
  // the draft counter travels with the car state (the HUD and a reload read it)
  assert.equal(afterSetup.raceState.cars[0]!.draftTurns, 0);

  const move = await submit(legalMove(afterSetup.raceState), 'first-move', afterSetup.revision);
  assert.equal(move.statusCode, 200);
  const late = await submit(
    { type: 'setup', setup: { ...setup, wing: 'high' } },
    'setup-late',
    (await readLobby(app, lobbyId, token)).revision
  );
  assert.equal(late.statusCode, 409);
  assert.equal((late.json() as { reason: string }).reason, 'setup_locked');
});

test("rules v2: the server's bots set up on the grid for the distance; a human keeps the plain setup", async (t) => {
  playRules(t, 'v2');
  const { app, raceState } = await startRace({
    totalCars: 3,
    humanCars: 1,
    botCars: 2,
    raceLaps: 3
  });
  t.after(() => app.close());
  const [human, ...bots] = raceState.cars;
  assert.equal(human!.setup.wing, 'medium');
  assert.equal(human!.setup.compound, 'hard');
  // 3 laps: a sprint, so soft tires and Low wing
  for (const bot of bots) {
    assert.equal(bot.setup.compound, 'soft');
    assert.equal(bot.setup.wing, 'low');
  }
});

// Rules v3 (#148). The server plays one version for every race: the engine's default, or RULES_VERSION.
function playRules(t: test.TestContext, version: string) {
  const before = process.env.RULES_VERSION;
  process.env.RULES_VERSION = version;
  t.after(() => {
    if (before === undefined) delete process.env.RULES_VERSION;
    else process.env.RULES_VERSION = before;
  });
}

const V3_SETUP = {
  compound: 'medium',
  psi: { fl: 32, fr: 32, rl: 32, rr: 32 },
  wing: 'medium',
  fuelLoad: 60
};

test('rules v3: the race says its rules, the human is dealt medium tires and a fuel load, and a grid setup takes both', async (t) => {
  playRules(t, 'v3');
  const { app, token, lobbyId, raceState, submit } = await startRace();
  t.after(() => app.close());
  assert.equal(raceState.rulesVersion, 'v3');
  assert.deepEqual(
    [raceState.cars[0]!.setup.compound, raceState.cars[0]!.setup.fuelLoad, raceState.cars[0]!.fuel],
    ['medium', 95, 95]
  );

  const bad = await submit({ type: 'setup', setup: { ...V3_SETUP, fuelLoad: 62 } }, 'load-bad');
  assert.equal(bad.statusCode, 409);
  assert.equal((bad.json() as { reason: string }).reason, 'invalid_setup');

  const ok = await submit({ type: 'setup', setup: V3_SETUP }, 'load-ok');
  assert.equal(ok.statusCode, 200);
  const car = (await readLobby(app, lobbyId, token)).raceState.cars[0]!;
  assert.deepEqual([car.setup.compound, car.setup.fuelLoad, car.fuel], ['medium', 60, 60]);
});

test('a server with no RULES_VERSION plays v3, the default', async (t) => {
  const before = process.env.RULES_VERSION;
  delete process.env.RULES_VERSION;
  t.after(() => {
    if (before !== undefined) process.env.RULES_VERSION = before;
  });
  const { app, raceState } = await startRace();
  t.after(() => app.close());
  assert.equal(raceState.rulesVersion, 'v3');
});

test('rules v2 (RULES_VERSION=v2): the medium compound and a fuel load are refused', async (t) => {
  playRules(t, 'v2');
  const { app, raceState, submit } = await startRace();
  t.after(() => app.close());
  assert.equal(raceState.rulesVersion, 'v2');
  for (const [name, setup] of [
    ['medium', { ...V3_SETUP, fuelLoad: undefined }],
    ['fuel load', { ...V3_SETUP, compound: 'hard' }]
  ] as const) {
    const res = await submit({ type: 'setup', setup }, `v2-${name}`);
    assert.equal(res.statusCode, 409, name);
    assert.equal((res.json() as { reason: string }).reason, 'invalid_setup', name);
  }
});

test('rules v3: a pit stop fits fresh tires and refuels to the load, and never takes fuel away', async (t) => {
  playRules(t, 'v3');
  for (const [fuelBefore, load, fuelAfter] of [
    [25, 80, 80],
    [90, 60, 90]
  ] as const) {
    const store = new LobbyStore();
    const app = await createApp(TEST_CONFIG, { logger: false, lobbyStore: store });
    t.after(() => app.close());
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/lobbies',
        payload: { name: 'Host', settings: { totalCars: 2, humanCars: 1, botCars: 1, raceLaps: 3 } }
      })
    ).json() as { lobby: { lobbyId: string }; playerToken: string };
    const { lobbyId } = created.lobby;
    await app.inject({
      method: 'POST',
      url: `/api/v1/lobbies/${lobbyId}/start`,
      payload: { playerToken: created.playerToken }
    });
    Object.assign(store.getLobby(lobbyId)!.race!.engine.cars[0]!, {
      cellId: 'Z01_L0_00',
      tire: 20,
      fuel: fuelBefore
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/lobbies/${lobbyId}/turns`,
      payload: {
        playerToken: created.playerToken,
        clientCommandId: `pit-${load}`,
        revision: 0,
        action: {
          type: 'pit',
          targetCellId: 'Z02_L0_00',
          setup: { ...V3_SETUP, fuelLoad: load }
        }
      }
    });
    assert.equal(res.statusCode, 200);
    const car = (await readLobby(app, lobbyId, created.playerToken)).raceState.cars[0]!;
    assert.deepEqual([car.tire, car.fuel], [100, fuelAfter]);
  }
});

test('only the newest command results are remembered for resends', async (t) => {
  const { app, submit } = await startRace();
  t.after(() => app.close());
  const illegal = { type: 'move', targetCellId: 'Z16_L3_00' } as const;

  assert.equal((await submit(illegal, 'c-0')).statusCode, 409);
  for (let i = 1; i <= MAX_DEDUPED_RESULTS; i += 1) await submit(illegal, `c-${i}`);

  // c-0 is the 201st result: forgotten, so it is judged again (409); the newest is still replayed (200).
  assert.equal((await submit(illegal, 'c-0')).statusCode, 409);
  assert.equal((await submit(illegal, `c-${MAX_DEDUPED_RESULTS}`)).statusCode, 200);
});

// #138: the server owns the play order and sends it (from v4 it changes every round), so the client never derives it.
test('rules v4: the race sends its play order, led by the active seat', async (t) => {
  playRules(t, 'v4');
  const { app, raceState } = await startRace();
  t.after(() => app.close());
  assert.equal(raceState.rulesVersion, 'v4');
  assert.deepEqual([...raceState.turnOrder].sort(), raceState.cars.map((c) => c.carId).sort());
  assert.equal(raceState.turnOrder[0], raceState.activeSeatIndex + 1);
});
