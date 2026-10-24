import { createHash } from 'node:crypto';
import pg from 'pg';
import type { RaceLog } from '../../src/game/race/race_log';

// The history of finished races (#170): an anonymous, append-only table of race logs (#169). A log is the whole race, so
// nothing else is kept: no player names, no ids, no addresses.
export type RaceSource = 'online' | 'solo';

export interface NewRace {
  source: RaceSource;
  trackId: string;
  log: RaceLog;
  winnerCarId: number;
}

export interface StoredRaceSummary {
  id: string;
  /** Epoch ms. */
  finishedAt: number;
  source: RaceSource;
  trackId: string;
  rulesVersion: string;
  laps: number;
  cars: number;
  winnerCarId: number;
}

export interface StoredRace extends StoredRaceSummary {
  log: RaceLog;
}

export interface RaceStore {
  /** `duplicate`: the same race was stored before (same id), nothing was added. */
  insert(race: NewRace): Promise<{ id: string; duplicate: boolean }>;
  /** Newest first. */
  list(limit: number): Promise<StoredRaceSummary[]>;
  get(id: string): Promise<StoredRace | null>;
  close(): Promise<void>;
}

/**
 * The log as it is kept: the seats lose the owner id (an online player's id) for a position-based one, and the bench-only
 * personality override goes. The race it replays is the same (the engine never reads the owner id to decide anything).
 */
export function scrubLog(log: RaceLog): RaceLog {
  return {
    ...log,
    seats: log.seats.map((seat, i) => ({
      isBot: seat.isBot,
      ownerId: seat.isBot ? `BOT${i + 1}` : `P${i + 1}`,
      ...(seat.botLevel ? { botLevel: seat.botLevel } : {})
    }))
  };
}

/** The same race gives the same id, so storing it twice is a no-op. */
export function raceId(log: RaceLog): string {
  return createHash('sha256').update(JSON.stringify(log)).digest('hex').slice(0, 16);
}

function summaryOf(id: string, finishedAt: number, race: NewRace): StoredRaceSummary {
  return {
    id,
    finishedAt,
    source: race.source,
    trackId: race.trackId,
    rulesVersion: race.log.rulesVersion,
    laps: race.log.raceLaps,
    cars: race.log.seats.length,
    winnerCarId: race.winnerCarId
  };
}

/** Dev and tests, and the server when no `DATABASE_URL` is set: kept until the process ends, the newest `limit` only. */
export class MemoryRaceStore implements RaceStore {
  private readonly races: StoredRace[] = [];

  constructor(private readonly limit = 500) {}

  insert(race: NewRace): Promise<{ id: string; duplicate: boolean }> {
    const log = scrubLog(race.log);
    const id = raceId(log);
    if (this.races.some((stored) => stored.id === id)) {
      return Promise.resolve({ id, duplicate: true });
    }
    this.races.unshift({ ...summaryOf(id, Date.now(), { ...race, log }), log });
    this.races.length = Math.min(this.races.length, this.limit);
    return Promise.resolve({ id, duplicate: false });
  }

  list(limit: number): Promise<StoredRaceSummary[]> {
    return Promise.resolve(this.races.slice(0, limit).map(({ log: _log, ...summary }) => summary));
  }

  get(id: string): Promise<StoredRace | null> {
    return Promise.resolve(this.races.find((race) => race.id === id) ?? null);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const SCHEMA = [
  `create table if not exists races (
     id text primary key,
     seq serial,
     finished_at timestamptz not null default now(),
     source text not null,
     track_id text not null,
     rules_version text not null,
     laps integer not null,
     cars integer not null,
     winner_car integer not null,
     log jsonb not null
   )`,
  'create index if not exists races_seq_idx on races (seq desc)'
];

interface Row {
  id: string;
  finished_at: number | string;
  source: RaceSource;
  track_id: string;
  rules_version: string;
  laps: number;
  cars: number;
  winner_car: number;
  log?: RaceLog;
}

function summaryOfRow(row: Row): StoredRaceSummary {
  return {
    id: row.id,
    finishedAt: Number(row.finished_at),
    source: row.source,
    trackId: row.track_id,
    rulesVersion: row.rules_version,
    laps: row.laps,
    cars: row.cars,
    winnerCarId: row.winner_car
  };
}

const COLUMNS =
  'id, (extract(epoch from finished_at) * 1000)::bigint as finished_at, source, track_id, rules_version, laps, cars, winner_car';

/** Postgres (Neon). The table is created on first use; the pool is any `pg`-shaped one, so a test can hand in an in-memory one. */
export class PgRaceStore implements RaceStore {
  private ready: Promise<void> | null = null;

  /**
   * `pool`: the app's queries (on Neon the pooled URL: a web server's many short requests). `migrationPool`: the schema
   * step, on Neon the direct URL as Neon advises for migrations; it is closed once the schema is there.
   */
  constructor(
    private readonly pool: Pick<pg.Pool, 'query' | 'end'>,
    private migrationPool: Pick<pg.Pool, 'query' | 'end'> | null = null
  ) {}

  private schema(): Promise<void> {
    this.ready ??= (async () => {
      const target = this.migrationPool ?? this.pool;
      for (const statement of SCHEMA) await target.query(statement);
      if (this.migrationPool) {
        const done = this.migrationPool;
        this.migrationPool = null;
        await done.end();
      }
    })().catch((error: unknown) => {
      this.ready = null; // try again on the next call (a database that was asleep)
      throw error;
    });
    return this.ready;
  }

  async insert(race: NewRace): Promise<{ id: string; duplicate: boolean }> {
    await this.schema();
    const log = scrubLog(race.log);
    const id = raceId(log);
    // Asked first rather than read from the insert's row count: the answer is the same on Postgres, and `on conflict` still
    // protects against two copies arriving at once.
    const known = await this.pool.query('select 1 from races where id = $1', [id]);
    if (known.rows.length > 0) return { id, duplicate: true };
    await this.pool.query(
      `insert into races (id, source, track_id, rules_version, laps, cars, winner_car, log)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (id) do nothing`,
      [
        id,
        race.source,
        race.trackId,
        log.rulesVersion,
        log.raceLaps,
        log.seats.length,
        race.winnerCarId,
        JSON.stringify(log)
      ]
    );
    return { id, duplicate: false };
  }

  async list(limit: number): Promise<StoredRaceSummary[]> {
    await this.schema();
    const result = await this.pool.query<Row>(
      `select ${COLUMNS} from races order by seq desc limit $1`,
      [limit]
    );
    return result.rows.map(summaryOfRow);
  }

  async get(id: string): Promise<StoredRace | null> {
    await this.schema();
    const result = await this.pool.query<Row>(`select ${COLUMNS}, log from races where id = $1`, [
      id
    ]);
    const row = result.rows[0];
    return row?.log ? { ...summaryOfRow(row), log: row.log } : null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Postgres when `DATABASE_URL` is set (Neon: the pooled URL, `sslmode=require` in it), memory otherwise. `directUrl`
 * (Neon's `DATABASE_URL_UNPOOLED`) is used for the schema step only, when given.
 *
 * node-postgres, not Neon's serverless driver: this is one long-running Node server (Render), which keeps its pool across
 * requests; the serverless driver is for runtimes that cannot.
 */
export function createRaceStore(
  databaseUrl: string | undefined,
  directUrl?: string | undefined
): RaceStore {
  if (!databaseUrl) return new MemoryRaceStore();
  return new PgRaceStore(
    new pg.Pool({
      connectionString: databaseUrl,
      max: 3,
      idleTimeoutMillis: 30_000,
      // a database that suspends takes a few seconds to wake
      connectionTimeoutMillis: 15_000
    }),
    directUrl
      ? new pg.Pool({ connectionString: directUrl, max: 1, connectionTimeoutMillis: 15_000 })
      : null
  );
}
