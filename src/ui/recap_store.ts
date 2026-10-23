import type { RaceLog } from '../game/race/race_log';

// The last races, kept in the browser (#169): enough to rebuild the recap of each (the action log and the car names).
// A log is a few tens of KB; the oldest goes first. Storage can be missing or full (private mode): then nothing is kept.
export interface SavedRace {
  id: string;
  finishedAt: number;
  trackId: string;
  /** The line the home screen lists: "Solo, 5 laps, you won". */
  label: string;
  /** Car names by car id (JSON object keys are strings). */
  names: Record<string, string>;
  log: RaceLog;
}

export const SAVED_RACES_KEY = 'srp:races';
export const SAVED_RACES_LIMIT = 10;

function read(storage: Storage): SavedRace[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(SAVED_RACES_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isSavedRace) : [];
  } catch {
    return [];
  }
}

function isSavedRace(value: unknown): value is SavedRace {
  if (typeof value !== 'object' || value === null) return false;
  const race = value as Partial<SavedRace>;
  return (
    typeof race.id === 'string' &&
    typeof race.label === 'string' &&
    typeof race.trackId === 'string' &&
    typeof race.log === 'object' &&
    race.log !== null &&
    Array.isArray(race.log.actions)
  );
}

/** Newest first. */
export function listSavedRaces(storage: Storage = window.localStorage): SavedRace[] {
  return read(storage);
}

export function loadSavedRace(
  id: string,
  storage: Storage = window.localStorage
): SavedRace | null {
  return read(storage).find((race) => race.id === id) ?? null;
}

/** Keeps `race` first and drops the oldest past the limit; when the storage is full, drops older races until it fits. */
export function saveRace(race: SavedRace, storage: Storage = window.localStorage): boolean {
  const races = [race, ...read(storage).filter((r) => r.id !== race.id)].slice(
    0,
    SAVED_RACES_LIMIT
  );
  while (races.length > 0) {
    try {
      storage.setItem(SAVED_RACES_KEY, JSON.stringify(races));
      return true;
    } catch {
      if (races.length === 1) return false;
      races.pop();
    }
  }
  return false;
}
