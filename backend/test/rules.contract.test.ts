import assert from "node:assert/strict";
import test from "node:test";
import type { BackendConfig } from "../src/config.js";
import { LobbyStore } from "../src/lobbyStore.js";
import { createApp } from "../src/server.js";
import type { RaceState } from "../src/types.js";
import { legalMove, playRaceToEnd, readLobby } from "./helpers.js";

const TEST_CONFIG: BackendConfig = {
  HOST: "127.0.0.1",
  PORT: 3001,
  CORS_ALLOWED_ORIGINS: "*",
  PLAYER_TOKEN_TTL_SECONDS: 86400
};

async function startRace(settings: Record<string, number> = { totalCars: 2, humanCars: 1, botCars: 1, raceLaps: 3 }) {
  const app = await createApp(TEST_CONFIG, { logger: false });
  const createdRes = await app.inject({
    method: "POST",
    url: "/api/v1/lobbies",
    payload: { name: "Host", settings }
  });
  const created = createdRes.json() as { lobby: { lobbyId: string }; playerToken: string };
  const startRes = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${created.lobby.lobbyId}/start`,
    payload: { playerToken: created.playerToken }
  });
  assert.equal(startRes.statusCode, 200);
  const raceState = (startRes.json() as { lobby: { raceState: RaceState } }).lobby.raceState;
  const submit = (action: unknown, clientCommandId: string, revision = 0) =>
    app.inject({
      method: "POST",
      url: `/api/v1/lobbies/${created.lobby.lobbyId}/turns`,
      payload: { playerToken: created.playerToken, clientCommandId, revision, action }
    });
  return { app, lobbyId: created.lobby.lobbyId, token: created.playerToken, raceState, submit };
}

test("rejects illegal actions without touching the race", async (t) => {
  const { app, lobbyId, token, raceState, submit } = await startRace();
  t.after(() => app.close());
  const hostSetup = raceState.cars[0]!.setup;
  const legal = legalMove(raceState);
  assert.equal(legal.type, "move");

  const cases: Array<[string, unknown, string]> = [
    ["unreachable cell", { type: "move", targetCellId: "Z16_L3_00" }, "invalid_target"],
    ["unknown cell", { type: "move", targetCellId: "nowhere" }, "invalid_target"],
    ["skip while moves are available", { type: "skip" }, "moves_available"],
    ["pit on a normal cell", { type: "pit", targetCellId: legal.type === "move" ? legal.targetCellId : "", setup: hostSetup }, "not_pit_box"]
  ];
  for (const [label, action, reason] of cases) {
    const res = await submit(action, `bad-${label}`);
    assert.equal(res.statusCode, 409, label);
    assert.deepEqual(
      { ok: false, error: "invalid_action", reason, revision: 0 },
      (({ ok, error, reason: r, revision }) => ({ ok, error, reason: r, revision }))(res.json())
    );
  }

  // Nothing moved, no turn was consumed, and the host can still play a legal move.
  const lobby = await readLobby(app, lobbyId, token);
  assert.equal(lobby.revision, 0);
  assert.equal(lobby.raceState.turnIndex, 0);
  assert.equal(lobby.raceState.activeSeatIndex, 0);
  assert.deepEqual(lobby.raceState.cars, raceState.cars);
  assert.equal((await submit(legal, "good-move")).statusCode, 200);
});

test("a rejected action is deduped: the same command id replays the same rejection", async (t) => {
  const { app, submit } = await startRace();
  t.after(() => app.close());

  const first = await submit({ type: "move", targetCellId: "Z16_L3_00" }, "same-id");
  const second = await submit({ type: "move", targetCellId: "Z16_L3_00" }, "same-id");

  assert.equal(first.statusCode, 409);
  assert.deepEqual(second.json(), first.json());
});

test("malformed turn payloads are a 400, not a server error", async (t) => {
  const { app, raceState, submit } = await startRace();
  t.after(() => app.close());
  const target = legalMove(raceState);
  assert.equal(target.type, "move");

  const noSetup = await submit({ type: "pit", targetCellId: "Z02_L0_00" }, "no-setup");
  const noTarget = await submit({ type: "move" }, "no-target");
  const badType = await submit({ type: "teleport", targetCellId: "Z02_L1_00" }, "bad-type");

  assert.deepEqual([noSetup.statusCode, noTarget.statusCode, badType.statusCode], [400, 400, 400]);
  assert.equal((noSetup.json() as { error: string }).error, "invalid_request");
});

test("rejects an unknown track when creating or configuring a lobby", async (t) => {
  const app = await createApp(TEST_CONFIG, { logger: false });
  t.after(() => app.close());

  const res = await app.inject({
    method: "POST",
    url: "/api/v1/lobbies",
    payload: { name: "Host", settings: { trackId: "../../etc/passwd" } }
  });

  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /Unknown trackId/);
});

test("the server plays the race to a winner and then closes it", async (t) => {
  const { app, lobbyId, token, submit } = await startRace({ totalCars: 2, humanCars: 1, botCars: 1, raceLaps: 1 });
  t.after(() => app.close());

  const finished = await playRaceToEnd(app, lobbyId, token);

  const race = finished.raceState;
  assert.equal(finished.status, "FINISHED");
  assert.equal(finished.terminationReason, "race_finished");
  assert.notEqual(race.winnerCarId, null);
  assert.ok((race.cars.find((car) => car.carId === race.winnerCarId)?.lapCount ?? 0) >= 1);
  const late = await submit({ type: "skip" }, "after-finish", finished.revision);
  assert.equal(late.statusCode, 409);
  assert.equal((late.json() as { error: string }).error, "lobby_not_in_race");
});

test("a pit stop needs a legal setup; a valid one refills the car and costs the next turn", async (t) => {
  const store = new LobbyStore();
  const app = await createApp(TEST_CONFIG, { logger: false, lobbyStore: store });
  t.after(() => app.close());
  const createdRes = await app.inject({
    method: "POST",
    url: "/api/v1/lobbies",
    payload: { name: "Host", settings: { totalCars: 2, humanCars: 1, botCars: 1, raceLaps: 3 } }
  });
  const created = createdRes.json() as { lobby: { lobbyId: string }; playerToken: string };
  const { lobbyId } = created.lobby;
  await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${lobbyId}/start`,
    payload: { playerToken: created.playerToken }
  });
  // Park the host's worn car in the pit lane, one step before the first pit box.
  const hostCar = store.getLobby(lobbyId)!.race!.engine.cars[0]!;
  Object.assign(hostCar, { cellId: "Z01_L0_00", tire: 20, fuel: 25 });
  const setup = { compound: "hard", psi: { fl: 22, fr: 22, rl: 20, rr: 20 }, wingFrontDeg: 4, wingRearDeg: 10 };
  const pit = (payloadSetup: unknown, clientCommandId: string, revision: number) =>
    app.inject({
      method: "POST",
      url: `/api/v1/lobbies/${lobbyId}/turns`,
      payload: {
        playerToken: created.playerToken,
        clientCommandId,
        revision,
        action: { type: "pit", targetCellId: "Z02_L0_00", setup: payloadSetup }
      }
    });

  const badSetup = await pit({ ...setup, psi: { ...setup.psi, fl: 99 } }, "pit-bad", 0);
  assert.equal(badSetup.statusCode, 409);
  assert.equal((badSetup.json() as { reason: string }).reason, "invalid_setup");
  assert.equal(hostCar.tire, 20);

  const ok = await pit(setup, "pit-ok", 0);
  assert.equal(ok.statusCode, 200);
  const lobby = await readLobby(app, lobbyId, created.playerToken);
  const car = lobby.raceState.cars[0]!;
  assert.deepEqual(
    [car.cellId, car.tire, car.fuel, car.pitServiced, car.setup.compound, car.setup.wingFrontDeg],
    ["Z02_L0_00", 100, 100, true, "hard", 4]
  );
  // The stop cost the host a turn: the bot played twice before it was the host's again.
  assert.equal(lobby.revision, 3);
  assert.equal(lobby.raceState.activeSeatIndex, 0);
  assert.deepEqual([car.state, car.pitTurnsRemaining, car.pitExitBoost], ["ACTIVE", 0, true]);
});
