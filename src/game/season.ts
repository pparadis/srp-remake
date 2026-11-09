import { isRulesVersion, type RulesVersion } from './rules/ids';
import type { SeasonCars } from './race/season_cars';
import { BOT_LEVELS, type BotLevel } from './types/car';
import { MAX_SEED, styleKeyOf, unit, type PersonalityKey } from './systems/bot_style';
import { randomPlayerName } from './player_name';

// A championship (#273): a fixed calendar of races raced by the same cars, scored with F1's points. One human against
// the same named bots for the whole season. Pure, no browser code (the backend bundles it; the browser's copy is
// src/ui/season_store.ts): a season keeps each race's finishing order itself, so the standings outlive the saved races
// (the browser keeps only the last 10).

/** The calendar every season plays (the tracks we have, see TRACK_CHOICES). */
export const SEASON_CALENDAR: readonly {
  trackId: string;
  raceLaps: number;
  /** The championship leader starts last: the grid is the standings reversed, not the seed's. */
  reversedGrid?: boolean;
}[] = [
  { trackId: 'oval16_3lanes', raceLaps: 5 },
  { trackId: 'oval32_3lanes', raceLaps: 3 },
  { trackId: 'oval16_3lanes', raceLaps: 3, reversedGrid: true },
  { trackId: 'oval16_3lanes', raceLaps: 8 }
];

/** F1's points for places 1 to 10; no points below. */
export const SEASON_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1] as const;

export interface SeasonDriver {
  carId: number;
  name: string;
  /** The bot's style for the whole season; a human has none. */
  style?: PersonalityKey;
  human: boolean;
}

export interface SeasonRace {
  trackId: string;
  raceLaps: number;
  seed: number;
  reversedGrid?: boolean;
  /** Set when the race is started: a race is not restarted, one that is quit is scored as a forfeit. */
  started?: boolean;
  result?: {
    /** Car ids, first place first. */
    order: number[];
    /** The saved race (recap) of it; null when the race was forfeited or could not be kept. */
    savedRaceId: string | null;
    forfeit?: boolean;
  };
}

export interface Season {
  id: string;
  startedAt: number;
  rulesVersion: RulesVersion;
  botLevel: BotLevel;
  drivers: SeasonDriver[];
  races: SeasonRace[];
}

/** A driver's line of the table. `places[i]` is the place in race i, null when it is not run yet. */
export interface StandingRow {
  driver: SeasonDriver;
  rank: number;
  points: number;
  places: (number | null)[];
}

export const HUMAN_CAR_ID = 1;

/**
 * The season of `humanCars` humans (cars 1 to humanCars; solo is one, named "You") and `botCars` bots. Names, styles and
 * race seeds come from `seed`, so they are fixed. `id` is for a lobby's season, which is picked up again by it and so
 * must not be guessable (the default is made of the clock and the seed); a lobby renames its humans as each race starts.
 */
export function newSeason(
  seed: number,
  botCars: number,
  botLevel: BotLevel,
  rulesVersion: RulesVersion,
  startedAt = Date.now(),
  humanCars = 1,
  id = `${startedAt.toString(36)}-${seed.toString(36)}`
): Season {
  const humanName = (carId: number) => (humanCars === 1 ? 'You' : `Player ${carId}`);
  const names = new Set<string>(Array.from({ length: humanCars }, (_human, i) => humanName(i + 1)));
  let dice = 0;
  const drivers: SeasonDriver[] = Array.from({ length: humanCars }, (_human, i) => ({
    carId: i + 1,
    name: humanName(i + 1),
    human: true
  }));
  for (let bot = 1; bot <= botCars; bot += 1) {
    let name = randomPlayerName(() => unit(seed, 0x6e616d65, (dice += 1)));
    // All names differ (the word lists make about 400); a clash draws again
    while (names.has(name)) name = randomPlayerName(() => unit(seed, 0x6e616d65, (dice += 1)));
    names.add(name);
    // Dealt by bot, not by car: the first five bots never share a style
    drivers.push({ carId: humanCars + bot, name, style: styleKeyOf(seed, bot), human: false });
  }
  return {
    id,
    startedAt,
    rulesVersion,
    botLevel,
    drivers,
    races: SEASON_CALENDAR.map((race, i) => ({
      ...race,
      seed: Math.floor(unit(seed, 0x72616365, i) * MAX_SEED) + 1
    }))
  };
}

/** The points of a place (1 is the winner). */
export function placePoints(place: number): number {
  return SEASON_POINTS[place - 1] ?? 0;
}

/** Drivers by points; a tie goes to the most wins, then second places and so on, then the better place in the last race. */
export function seasonStandings(season: Season): StandingRow[] {
  const played = season.races.map((race) => race.result?.order ?? null);
  const rows = season.drivers.map((driver) => {
    const places = played.map((order) => {
      const at = order?.indexOf(driver.carId) ?? -1;
      return at < 0 ? null : at + 1;
    });
    return {
      driver,
      places,
      points: places.reduce<number>((sum, p) => sum + (p ? placePoints(p) : 0), 0)
    };
  });
  const count = (row: (typeof rows)[number], place: number) =>
    row.places.filter((p) => p === place).length;
  const last = (row: (typeof rows)[number]) =>
    [...row.places].reverse().find((p) => p !== null) ?? Infinity;
  rows.sort((a, b) => {
    if (a.points !== b.points) return b.points - a.points;
    for (let place = 1; place <= season.drivers.length; place += 1) {
      if (count(a, place) !== count(b, place)) return count(b, place) - count(a, place);
    }
    return last(a) - last(b) || a.driver.carId - b.driver.carId;
  });
  return rows.map((row, i) => ({ ...row, rank: i + 1 }));
}

/** The index of the race to play next (the first with no result), or null when the season is over. */
export function nextRaceIndex(season: Season): number | null {
  const i = season.races.findIndex((race) => !race.result);
  return i < 0 ? null : i;
}

export function isSeasonFinished(season: Season): boolean {
  return nextRaceIndex(season) === null;
}

/** The champion once the season is finished. */
export function champion(season: Season): SeasonDriver | null {
  return isSeasonFinished(season) ? (seasonStandings(season)[0]?.driver ?? null) : null;
}

/**
 * The grid slot of each car (as `createRace` takes it) for a race on a reversed grid: the leader of the standings
 * starts last. Undefined for a race on the seed's grid.
 */
export function seasonGrid(season: Season, raceIndex: number): number[] | undefined {
  if (!season.races[raceIndex]?.reversedGrid) return undefined;
  const grid: number[] = [];
  seasonStandings(season).forEach((row, i, rows) => {
    grid[row.driver.carId - 1] = rows.length - 1 - i;
  });
  return grid;
}

/** What a season race pins on its cars, as the game takes it: the names, the styles (a human's is never read) and the grid. */
export function seasonCars(season: Season, raceIndex: number): SeasonCars {
  const grid = seasonGrid(season, raceIndex);
  return {
    names: season.drivers.map((d) => (d.human ? '' : d.name)),
    styles: season.drivers.map((d) => d.style ?? 'balanced'),
    ...(grid ? { grid } : {})
  };
}

/** The drivers under the names given by car id (a lobby's players, as each race starts); the others keep theirs. */
export function renameDrivers(season: Season, names: Record<number, string>): Season {
  return {
    ...season,
    drivers: season.drivers.map((d) => ({ ...d, name: names[d.carId] ?? d.name }))
  };
}

function withRace(season: Season, raceIndex: number, change: Partial<SeasonRace>): Season {
  return {
    ...season,
    races: season.races.map((race, i) => (i === raceIndex ? { ...race, ...change } : race))
  };
}

/** Marks the race as started (the card then offers the next one, never this one again). */
export function startSeasonRace(season: Season, raceIndex: number): Season {
  return season.races[raceIndex] && !season.races[raceIndex].result
    ? withRace(season, raceIndex, { started: true })
    : season;
}

/** Records a race's finishing order; a race that already has a result, or an order that is not the drivers', is ignored. */
export function recordResult(
  season: Season,
  raceIndex: number,
  order: number[],
  savedRaceId: string | null
): Season {
  const race = season.races[raceIndex];
  const ids = season.drivers.map((d) => d.carId);
  if (!race || race.result) return season;
  if (order.length !== ids.length || !ids.every((id) => order.includes(id))) return season;
  return withRace(season, raceIndex, { started: true, result: { order, savedRaceId } });
}

/**
 * A race that was started and not finished is over: the humans score last place, the bots keep their relative standing
 * (each gets the place its row of the table has among the bots), so quitting never helps and never reshuffles a rival.
 */
export function forfeitUnfinished(season: Season): Season {
  let next = season;
  season.races.forEach((race, i) => {
    if (!race.started || race.result) return;
    const rows = seasonStandings(next);
    const order = [
      ...rows.filter((r) => !r.driver.human),
      ...rows.filter((r) => r.driver.human)
    ].map((r) => r.driver.carId);
    next = withRace(next, i, { result: { order, savedRaceId: null, forfeit: true } });
  });
  return next;
}

// ---- what a stored or sent season must look like -----------------------------------------------------------------

/** What a stored value is: a season, or why it was dropped (`retired`: its rules version is no longer selectable). */
export function parseSeason(value: unknown): Season | 'retired' | null {
  if (typeof value !== 'object' || value === null) return null;
  const s = value as Partial<Record<keyof Season, unknown>>;
  if (typeof s.id !== 'string' || typeof s.startedAt !== 'number') return null;
  if (typeof s.rulesVersion === 'string' && !isRulesVersion(s.rulesVersion)) return 'retired';
  if (!isRulesVersion(s.rulesVersion)) return null;
  if (!BOT_LEVELS.some((level) => level === s.botLevel)) return null;
  const { drivers, races } = s;
  if (!Array.isArray(drivers) || !Array.isArray(races) || races.length === 0) return null;
  if (!drivers.every(isDriver) || !races.every(isRace)) return null;
  const ids = drivers.map((d) => d.carId);
  const results = races.flatMap((race) => (race.result ? [race.result] : []));
  const orderOk = results.every(
    (r) => r.order.length === ids.length && ids.every((id) => r.order.includes(id))
  );
  return new Set(ids).size === ids.length && orderOk ? (value as Season) : null;
}

function isDriver(value: unknown): value is SeasonDriver {
  const d = value as Partial<SeasonDriver> | null;
  return (
    typeof d === 'object' &&
    d !== null &&
    Number.isInteger(d.carId) &&
    typeof d.name === 'string' &&
    typeof d.human === 'boolean' &&
    (d.style === undefined || typeof d.style === 'string')
  );
}

function isRace(value: unknown): value is SeasonRace {
  const r = value as Partial<SeasonRace> | null;
  if (typeof r !== 'object' || r === null) return false;
  const result = r.result;
  return (
    typeof r.trackId === 'string' &&
    Number.isInteger(r.raceLaps) &&
    Number.isInteger(r.seed) &&
    (result === undefined ||
      (Array.isArray(result.order) &&
        result.order.every(Number.isInteger) &&
        (result.savedRaceId === null || typeof result.savedRaceId === 'string')))
  );
}
