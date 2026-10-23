/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import type { RaceLog } from '../game/race/race_log';
import {
  SAVED_RACES_KEY,
  SAVED_RACES_LIMIT,
  listSavedRaces,
  loadSavedRace,
  saveRace,
  type SavedRace
} from './recap_store';

const log: RaceLog = {
  seats: [{ isBot: false, ownerId: 'P1' }],
  raceLaps: 1,
  seed: 0,
  rulesVersion: 'v3',
  actions: []
};
const race = (id: string): SavedRace => ({
  id,
  finishedAt: 1,
  trackId: 'oval16_3lanes',
  label: `Race ${id}`,
  names: { '1': 'You' },
  log
});

describe('recap store (#169)', () => {
  beforeEach(() => window.localStorage.clear());

  it('keeps races newest first and finds one by id', () => {
    saveRace(race('a'));
    saveRace(race('b'));
    expect(listSavedRaces().map((r) => r.id)).toEqual(['b', 'a']);
    expect(loadSavedRace('a')?.label).toBe('Race a');
    expect(loadSavedRace('zzz')).toBeNull();
  });

  it('saving a race again replaces it instead of listing it twice', () => {
    saveRace(race('a'));
    saveRace(race('b'));
    saveRace({ ...race('a'), label: 'again' });
    expect(listSavedRaces().map((r) => r.id)).toEqual(['a', 'b']);
    expect(loadSavedRace('a')?.label).toBe('again');
  });

  it('drops the oldest past the limit', () => {
    for (let i = 0; i < SAVED_RACES_LIMIT + 3; i += 1) saveRace(race(`r${i}`));
    const ids = listSavedRaces().map((r) => r.id);
    expect(ids).toHaveLength(SAVED_RACES_LIMIT);
    expect(ids[0]).toBe(`r${SAVED_RACES_LIMIT + 2}`);
    expect(ids).not.toContain('r0');
  });

  it('reads nothing from a broken or foreign value', () => {
    window.localStorage.setItem(SAVED_RACES_KEY, 'not json');
    expect(listSavedRaces()).toEqual([]);
    window.localStorage.setItem(SAVED_RACES_KEY, JSON.stringify([{ id: 5 }, race('ok')]));
    expect(listSavedRaces().map((r) => r.id)).toEqual(['ok']);
  });

  it('drops older races when the storage is full, and gives up if even one does not fit', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (value.length > 800) throw new Error('quota');
        store.set(key, value);
      }
    } as Pick<Storage, 'getItem' | 'setItem'> as Storage;
    expect(saveRace(race('a'), storage)).toBe(true);
    expect(saveRace(race('b'), storage)).toBe(true);
    expect(saveRace(race('c'), storage)).toBe(true);
    expect(listSavedRaces(storage).map((r) => r.id)[0]).toBe('c');
    const big = { ...race('big'), label: 'x'.repeat(2000) };
    expect(saveRace(big, storage)).toBe(false);
  });
});
