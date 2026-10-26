import { activeSeatIndex, createRaceContext, type RaceState } from '../game/race/race_engine';
import { replayRace } from '../game/race/race_log';
import { raceRecap, type RaceRecap } from '../game/systems/race_recap';
import type { PublicLobby, PublicRaceState } from '../net/backend_api';
import { parseTrack } from '../validation/track_schema';
import type { SavedRace } from './recap_store';

// A saved race replayed on the board (#169): every state of the race, each dressed as the server's lobby state, so the
// race scene shows it the way it shows an online race it only watches. Lazy like `recap_load.ts`: the engine is in it.
export interface Replay {
  /** The grid, then the race after each action: `states.length` = actions + 1. */
  count: number;
  /** The lobby state of the n-th state (0 = the grid), as the server would send it. */
  lobbyAt: (index: number) => PublicLobby;
  /** What happened to get to the n-th state ("Car 2 +8 cells"); empty for the grid. */
  textAt: (index: number) => string;
  recap: RaceRecap;
}

function publicRace(states: RaceState[], index: number, saved: SavedRace): PublicRaceState {
  const state = states[index] as RaceState;
  return {
    trackId: saved.trackId,
    raceLaps: state.raceLaps,
    turnIndex: index,
    activeSeatIndex: activeSeatIndex(state),
    turnOrder: state.turn.order,
    winnerCarId: state.winnerCarId,
    seed: state.seed,
    ...(state.rulesVersion ? { rulesVersion: state.rulesVersion } : {}),
    cars: state.cars.map((car) => ({
      ...car,
      seatIndex: car.carId - 1,
      playerId: null,
      name: saved.names[String(car.carId)] ?? `Car ${car.carId}`
    }))
  };
}

export async function buildReplay(saved: SavedRace, baseUrl: string): Promise<Replay> {
  const response = await fetch(`${baseUrl}tracks/${encodeURIComponent(saved.trackId)}.json`);
  if (!response.ok) throw new Error(`Track ${saved.trackId} not found (${response.status}).`);
  const ctx = createRaceContext(parseTrack(await response.json()));
  const states = replayRace(ctx, saved.log);
  const nameOf = (carId: number) => saved.names[String(carId)] ?? `Car ${carId}`;
  const recap = raceRecap(ctx, saved.log, nameOf);
  const cars = saved.log.seats.length;
  return {
    count: states.length,
    recap,
    lobbyAt: (index) => {
      const state = states[index] as RaceState;
      return {
        lobbyId: saved.id,
        status: state.winnerCarId === null ? 'IN_RACE' : 'FINISHED',
        hostPlayerId: '',
        createdAt: saved.finishedAt,
        updatedAt: saved.finishedAt,
        revision: index,
        settings: {
          trackId: saved.trackId,
          totalCars: cars,
          humanCars: cars,
          botCars: 0,
          raceLaps: saved.log.raceLaps,
          turnTimerSec: 0,
          botLevel: 'normal'
        },
        players: [],
        raceState: publicRace(states, index, saved)
      };
    },
    textAt: (index) => {
      const turn = recap.turns[index - 1];
      return turn ? turn.lines.map((line) => line.text).join('. ') : '';
    }
  };
}
