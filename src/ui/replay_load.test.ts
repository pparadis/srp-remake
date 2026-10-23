/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import track from '../../public/tracks/oval16_3lanes.json';
import {
  applyAction,
  createRace,
  createRaceContext,
  decideBotAction,
  type RaceSeat
} from '../game/race/race_engine';
import { logAction, replayRace, startRaceLog } from '../game/race/race_log';
import type { TrackData } from '../game/types/track';
import { toEngineRace } from '../net/race_sync';
import { buildReplay } from './replay_load';
import type { SavedRace } from './recap_store';

const ctx = createRaceContext(track as unknown as TrackData);
const SEATS: RaceSeat[] = [
  { isBot: true, ownerId: 'BOT1', botLevel: 'normal' },
  { isBot: true, ownerId: 'BOT2', botLevel: 'hard' },
  { isBot: true, ownerId: 'BOT3', botLevel: 'easy' }
];

function savedRace(): SavedRace {
  const state = createRace(ctx, SEATS, 4, 5, 'v3');
  const log = startRaceLog(SEATS, 4, 5, 'v3');
  while (state.winnerCarId === null) {
    const action = decideBotAction(ctx, state).action;
    applyAction(ctx, state, action);
    logAction(log, action);
  }
  return {
    id: 'r1',
    finishedAt: 1,
    trackId: 'oval16_3lanes',
    label: 'Solo, 4 laps, Racer 1 won',
    names: { '1': 'Racer 1', '2': 'Racer 2', '3': 'Racer 3' },
    log
  };
}

describe('buildReplay (#169)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('dresses every state of the race as the lobby state the scene knows from an online race', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(track), { status: 200 }))
    );
    const saved = savedRace();
    const replay = await buildReplay(saved, '/');
    const states = replayRace(ctx, saved.log);
    expect(replay.count).toBe(states.length);
    for (let i = 0; i < states.length; i += 1) {
      const lobby = replay.lobbyAt(i);
      // the scene turns it back into the engine state the race was in
      expect(toEngineRace(lobby.raceState!)).toEqual(states[i]);
      expect(lobby.revision).toBe(i);
      expect(lobby.status).toBe(i === states.length - 1 ? 'FINISHED' : 'IN_RACE');
    }
  });

  it('names the cars, seats them all as humans nobody controls, and says what each step did', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(track), { status: 200 }))
    );
    const replay = await buildReplay(savedRace(), '/');
    const lobby = replay.lobbyAt(3);
    expect(lobby.raceState!.cars.map((c) => c.name)).toEqual(['Racer 1', 'Racer 2', 'Racer 3']);
    expect(lobby.raceState!.cars.every((c) => c.playerId === null)).toBe(true);
    expect(lobby.settings).toMatchObject({ totalCars: 3, humanCars: 3, botCars: 0, raceLaps: 4 });
    expect(replay.textAt(0)).toBe('');
    expect(replay.textAt(1)).toContain('Racer');
    expect(replay.recap.turns).toHaveLength(replay.count - 1);
  });

  it('fails clearly when the track cannot be had', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 }))
    );
    await expect(buildReplay(savedRace(), '/')).rejects.toThrow(/not found/);
  });
});
