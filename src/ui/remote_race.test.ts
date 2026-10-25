import { describe, expect, it } from 'vitest';
import type { RaceLog } from '../game/race/race_log';
import { loadRemoteRace } from './remote_race';

const log = {
  seats: [
    { isBot: false, ownerId: 'P1' },
    { isBot: true, ownerId: 'BOT2' },
    { isBot: true, ownerId: 'BOT3' }
  ],
  raceLaps: 1,
  seed: 1,
  rulesVersion: 'v3',
  actions: []
} as RaceLog;

const client = (over: object) =>
  ({
    readRace: () =>
      Promise.resolve({
        id: 'abc',
        finishedAt: 5,
        source: 'online',
        trackId: 'oval16_3lanes',
        winnerCarId: 2,
        log,
        ...over
      })
  }) as never;

describe('a race of the public history (#202)', () => {
  it('names the cars by seat and says who won', async () => {
    const saved = await loadRemoteRace(client({}), 'abc');
    expect(saved.names).toEqual({ '1': 'Player 1', '2': 'Bot 2', '3': 'Bot 3' });
    expect(saved.label).toBe('Online, 1 lap, Bot 2 won');
    expect(saved).toMatchObject({ id: 'abc', finishedAt: 5, trackId: 'oval16_3lanes', log });
  });

  it('calls a solo race Solo, pluralises laps, and survives an unknown winner', async () => {
    const saved = await loadRemoteRace(
      client({ source: 'solo', winnerCarId: 9, log: { ...log, raceLaps: 5 } }),
      'abc'
    );
    expect(saved.label).toBe('Solo, 5 laps, someone won');
  });

  it('lets the request error through, for the page to say', async () => {
    const failing = { readRace: () => Promise.reject(new Error('503')) } as never;
    await expect(loadRemoteRace(failing, 'abc')).rejects.toThrow('503');
  });
});
