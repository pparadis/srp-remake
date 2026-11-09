import { isSeasonFinished, parseSeason, type Season } from '../game/season';

// The browser's copy of a championship (#273), with the `Storage` injected as in recap_store.ts. The model itself
// (src/game/season.ts) has no browser code, since the backend bundles it.

export const SEASON_KEY = 'srp:season';

/** The stored season; null when there is none, it is broken, or it was on a retired rules version (`retired`). */
export function loadSeason(storage: Storage = window.localStorage): {
  season: Season | null;
  retired: boolean;
} {
  try {
    const raw = storage.getItem(SEASON_KEY);
    if (raw === null) return { season: null, retired: false };
    const parsed = parseSeason(JSON.parse(raw));
    if (parsed === null || parsed === 'retired') {
      clearSeason(storage);
      return { season: null, retired: parsed === 'retired' };
    }
    return { season: parsed, retired: false };
  } catch {
    return { season: null, retired: false };
  }
}

/** False when the storage is full or missing: the season then lives only in the page. */
export function saveSeason(season: Season, storage: Storage = window.localStorage): boolean {
  try {
    storage.setItem(SEASON_KEY, JSON.stringify(season));
    return true;
  } catch {
    return false;
  }
}

export function clearSeason(storage: Storage = window.localStorage): void {
  try {
    storage.removeItem(SEASON_KEY);
  } catch {
    // storage unavailable: nothing to clear
  }
}

// ---- the lobby's championship (#273) -------------------------------------------------------------------------------
// The standings live on the server; the browser keeps only the id that picks the season up again in a new lobby, and a
// line to say which one it is.

export const ONLINE_SEASON_KEY = 'srp:online-season';

export interface OnlineSeasonRef {
  id: string;
  label: string;
}

export function loadOnlineSeason(storage: Storage = window.localStorage): OnlineSeasonRef | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(ONLINE_SEASON_KEY) ?? 'null');
    const ref = value as Partial<OnlineSeasonRef> | null;
    return typeof ref?.id === 'string' && typeof ref.label === 'string'
      ? { id: ref.id, label: ref.label }
      : null;
  } catch {
    return null;
  }
}

/** Remembers a running season; one that is over (or none) is forgotten, there is nothing left to resume. */
export function rememberOnlineSeason(
  season: Season | null,
  label: string,
  storage: Storage = window.localStorage
): void {
  try {
    if (season && !isSeasonFinished(season)) {
      storage.setItem(ONLINE_SEASON_KEY, JSON.stringify({ id: season.id, label }));
    } else {
      storage.removeItem(ONLINE_SEASON_KEY);
    }
  } catch {
    // storage unavailable: the season simply cannot be resumed from this browser
  }
}
