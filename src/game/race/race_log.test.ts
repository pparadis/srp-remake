import { describe, expect, it } from 'vitest';
import track from '../../../public/tracks/oval16_3lanes.json';
import { RULES_VERSIONS, type RulesVersion } from '../rules/ids';
import type { TrackData } from '../types/track';
import {
  applyAction,
  createRace,
  createRaceContext,
  decideBotAction,
  getActiveCar,
  type RaceAction,
  type RaceSeat
} from './race_engine';
import { logAction, replayRace, startRaceLog } from './race_log';

const ctx = createRaceContext(track as unknown as TrackData);

// One human seat (played by the autopilot, after a grid setup on v3) and bots of every level: every kind of action.
const SEATS: RaceSeat[] = [
  { isBot: false, ownerId: 'P1' },
  { isBot: true, ownerId: 'BOT1', botLevel: 'easy' },
  { isBot: true, ownerId: 'BOT2', botLevel: 'normal' },
  { isBot: true, ownerId: 'BOT3', botLevel: 'hard' }
];

function playLogged(rulesVersion: RulesVersion, seed: number, laps: number) {
  const state = createRace(ctx, SEATS, laps, seed, rulesVersion);
  const log = startRaceLog(SEATS, laps, seed, rulesVersion);
  const play = (action: RaceAction) => {
    const result = applyAction(ctx, state, action);
    expect(result.ok, JSON.stringify(action)).toBe(true);
    logAction(log, action);
  };
  if (rulesVersion === 'v3') {
    const human = state.cars[0]!;
    while (getActiveCar(state).carId !== human.carId) {
      play(decideBotAction(ctx, state).action);
    }
    play({ type: 'setup', setup: { ...human.setup, compound: 'soft', fuelLoad: 80 } });
  }
  for (let turn = 0; turn < 2000 && state.winnerCarId === null; turn += 1) {
    const car = getActiveCar(state);
    play(decideBotAction(ctx, state, car.isBot ? undefined : 'autopilot').action);
  }
  return { state, log };
}

describe('race log (#169)', () => {
  it.each(RULES_VERSIONS.flatMap((v) => [1, 7].map((seed) => [v, seed] as const)))(
    'replays a %s race (seed %d) to exactly the state the live race ended in',
    (rulesVersion, seed) => {
      const { state, log } = playLogged(rulesVersion, seed, 6);
      expect(state.winnerCarId).not.toBeNull();
      const states = replayRace(ctx, log);
      expect(states).toHaveLength(log.actions.length + 1);
      expect(states.at(-1)).toEqual(state);
    }
  );

  it('covers pit stops and grid setups', () => {
    const kinds = new Set(
      RULES_VERSIONS.flatMap((v) => playLogged(v, 3, 12).log.actions.map((a) => a.type))
    );
    expect(kinds).toContain('pit');
    expect(kinds).toContain('setup');
    expect(kinds).toContain('move');
  });

  it('starts from the grid: the first state is what createRace makes', () => {
    const { log } = playLogged('v3', 1, 1);
    expect(replayRace(ctx, log)[0]).toEqual(createRace(ctx, SEATS, 1, 1, 'v3'));
  });

  it('keeps a copy of each action, so a later change to the caller object does not rewrite history', () => {
    const log = startRaceLog(SEATS, 1, 0, 'v3');
    const action = { type: 'move' as const, targetCellId: 'Z02_L1_00' };
    logAction(log, action);
    action.targetCellId = 'elsewhere';
    expect(log.actions[0]).toEqual({ type: 'move', targetCellId: 'Z02_L1_00' });
  });

  it('throws when an action does not fit the race it claims to be from', () => {
    const { log } = playLogged('v2', 1, 1);
    const broken = { ...log, actions: [{ type: 'move', targetCellId: 'nowhere' } as const] };
    expect(() => replayRace(ctx, broken)).toThrow(/action 0 refused/);
  });
});
