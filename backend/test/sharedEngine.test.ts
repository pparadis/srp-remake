import assert from "node:assert/strict";
import test from "node:test";
import track from "../../public/tracks/oval16_3lanes.json";
import {
  applyAction,
  createRace,
  createRaceContext,
  decideBotAction
} from "../../src/game/race/raceEngine";
import type { TrackData } from "../../src/game/types/track";

// The backend runs the same race engine as the browser; this proves the shared
// source resolves, type-checks and runs under the backend toolchain.
test("backend can run a full race with the shared game engine", () => {
  const ctx = createRaceContext(track as unknown as TrackData);
  const state = createRace(
    ctx,
    [
      { isBot: true, ownerId: "BOT1" },
      { isBot: true, ownerId: "BOT2" }
    ],
    1
  );

  for (let i = 0; i < 1000 && state.winnerCarId === null; i += 1) {
    const result = applyAction(ctx, state, decideBotAction(ctx, state).action);
    assert.equal(result.ok, true);
  }

  assert.notEqual(state.winnerCarId, null);
});

// Hard clones the race (structuredClone) and plays rivals on the copy; check that also runs here.
test("every bot level plays a race under the backend toolchain", () => {
  const ctx = createRaceContext(track as unknown as TrackData);
  for (const botLevel of ["easy", "normal", "hard"] as const) {
    const state = createRace(
      ctx,
      [1, 2, 3].map((n) => ({ isBot: true, ownerId: `BOT${n}`, botLevel })),
      1
    );
    for (let i = 0; i < 1000 && state.winnerCarId === null; i += 1) {
      assert.equal(applyAction(ctx, state, decideBotAction(ctx, state).action).ok, true);
    }
    assert.notEqual(state.winnerCarId, null, botLevel);
  }
});
