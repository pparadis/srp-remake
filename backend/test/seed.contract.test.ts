import assert from "node:assert/strict";
import test from "node:test";
import { gridSlots, turnOrderOf } from "../../src/game/systems/botStyle.js";
import type { BackendConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import type { PublicLobby } from "../src/types.js";

const TEST_CONFIG: BackendConfig = {
  HOST: "127.0.0.1",
  PORT: 3001,
  CORS_ALLOWED_ORIGINS: "*",
  PLAYER_TOKEN_TTL_SECONDS: 86400,
  HOST_GRACE_SECONDS: 45,
  TURN_TIMER_TIME_SCALE: 1
};

async function startRace(seedEnv: string | undefined) {
  if (seedEnv === undefined) delete process.env.BOT_SEED;
  else process.env.BOT_SEED = seedEnv;
  const app = await createApp(TEST_CONFIG, { logger: false });
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/lobbies",
    payload: { name: "Host", settings: { humanCars: 1, botCars: 3, totalCars: 4, raceLaps: 3 } }
  });
  const body = created.json() as { lobby: PublicLobby; playerToken: string };
  const started = await app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${body.lobby.lobbyId}/start`,
    payload: { playerToken: body.playerToken }
  });
  assert.equal(started.statusCode, 200);
  await app.close();
  return (started.json() as { lobby: PublicLobby }).lobby.raceState!;
}

test("BOT_SEED pins the race seed and the grid: seed 6 puts car 3 at the back and car 4 on the outer lane", async () => {
  const race = await startRace("6");
  assert.equal(race.seed, 6);
  assert.deepEqual(gridSlots(6, 4), [0, 1, 3, 2]);
  assert.equal(race.activeSeatIndex, 0); // the human is on pole and plays first
  assert.deepEqual(
    race.cars.map((car) => [car.carId, car.cellId, car.lapCount]),
    [[1, "Z01_L1_00", 0], [2, "Z01_L2_00", 0], [3, "Z28_L1_00", -1], [4, "Z01_L3_00", 0]]
  );
});

test("bots that start ahead of the human in the play order move before its first turn", async () => {
  const race = await startRace("7");
  assert.notEqual(turnOrderOf(7, 4)[0], 1);
  assert.ok(race.turnIndex > 0);
  assert.equal(race.activeSeatIndex, 0);
  assert.ok(race.cars.some((car) => car.isBot && car.cellId !== "Z01_L1_00"));
});

test("BOT_SEED=0 keeps the fixed grid; an unset BOT_SEED rolls a positive seed per race", async () => {
  const fixed = await startRace("0");
  assert.equal(fixed.seed, 0);
  assert.equal(fixed.activeSeatIndex, 0);
  assert.equal(fixed.cars[0]!.cellId, "Z01_L1_00");

  const a = await startRace(undefined);
  const b = await startRace(undefined);
  assert.ok(a.seed > 0 && b.seed > 0);
  assert.notEqual(a.seed, b.seed);
  process.env.BOT_SEED = "0";
});
