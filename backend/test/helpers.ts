import track from "../../public/tracks/oval16_3lanes.json";
import {
  computeTargets,
  createRaceContext,
  getActiveCar,
  type RaceAction,
  type RaceState as EngineRaceState
} from "../../src/game/race/raceEngine";
import type { TrackData } from "../../src/game/types/track";
import type { RaceState } from "../src/types.js";

const ctx = createRaceContext(track as unknown as TrackData);

// Rebuilds the engine state from the server's public race state.
export function toEngineState(raceState: RaceState): EngineRaceState {
  const cars = raceState.cars.map(({ seatIndex: _s, playerId: _p, name: _n, ...car }) => car);
  return {
    cars,
    turn: { order: cars.map((car) => car.carId), index: raceState.activeSeatIndex },
    raceLaps: raceState.raceLaps,
    winnerCarId: raceState.winnerCarId
  };
}

// A legal move for the seat whose turn it is (the lowest-id reachable cell).
export function legalMove(raceState: RaceState): RaceAction {
  const state = toEngineState(raceState);
  const [target] = Array.from(computeTargets(ctx, state, getActiveCar(state)).keys()).sort();
  if (!target) throw new Error("active car has no legal move");
  return { type: "move", targetCellId: target };
}

type InjectApp = Awaited<ReturnType<typeof import("../src/server.js").createApp>>;

export async function readLobby(app: InjectApp, lobbyId: string, playerToken: string) {
  const res = await app.inject({
    method: "GET",
    url: `/api/v1/lobbies/${lobbyId}?playerToken=${encodeURIComponent(playerToken)}`
  });
  return (res.json() as { lobby: { status: string; revision: number; terminationReason?: string; raceState: RaceState } }).lobby;
}

// Submits legal moves for the (only) human seat until the race ends; returns the final lobby.
export async function playRaceToEnd(app: InjectApp, lobbyId: string, playerToken: string) {
  for (let i = 0; i < 400; i += 1) {
    const lobby = await readLobby(app, lobbyId, playerToken);
    if (lobby.status === "FINISHED") return lobby;
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/lobbies/${lobbyId}/turns`,
      payload: {
        playerToken,
        clientCommandId: `play-${i}`,
        revision: lobby.revision,
        action: legalMove(lobby.raceState)
      }
    });
    if (res.statusCode !== 200) throw new Error(`turn rejected: ${res.statusCode} ${res.body}`);
  }
  throw new Error("race did not finish");
}
