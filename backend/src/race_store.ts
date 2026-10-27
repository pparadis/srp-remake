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
  /** `deviceHash` of the uploader (#194); none for a race the server stores itself. Never given back by `list` or `get`. */
  device?: string;
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

// One device may hold this many races of the history; its next one replaces its own oldest, never another device's.
export const MAX_RACES_PER_DEVICE = 50;

// Over its limit, the history drops the oldest race of the owner holding the most (#194). An owner is a device, or a race
// with no device (an online one) on its own, so those go only when nobody holds more than one. A tie goes to the owner whose
// oldest race is oldest. So a script that mints tokens takes races from its own tokens, not from real players'.

/** Dev and tests, and the server when no `DATABASE_URL` is set: kept until the process ends, `limit` races at most. */
export class MemoryRaceStore implements RaceStore {
  private readonly races: Array<{ race: StoredRace; device: string | undefined }> = [];

  constructor(
    private readonly limit = 500,
    private readonly perDevice = MAX_RACES_PER_DEVICE
  ) {}

  insert(race: NewRace): Promise<{ id: string; duplicate: boolean }> {
    const log = scrubLog(race.log);
    const id = raceId(log);
    if (this.races.some((stored) => stored.race.id === id)) {
      return Promise.resolve({ id, duplicate: true });
    }
    this.races.unshift({
      race: { ...summaryOf(id, Date.now(), { ...race, log }), log },
      device: race.device
    });
    if (race.device) {
      const mine = this.races.filter((stored) => stored.device === race.device);
      for (const stored of mine.slice(this.perDevice)) {
        this.races.splice(this.races.indexOf(stored), 1);
      }
    }
    while (this.races.length > this.limit) this.evictFromHeaviest();
    return Promise.resolve({ id, duplicate: false });
  }

  private evictFromHeaviest(): void {
    // `races` is newest first, so the last index an owner turns up at is its oldest race.
    const owners = new Map<string, { count: number; oldest: number }>();
    this.races.forEach(({ race, device }, index) => {
      const owner = device ?? race.id;
      const entry = owners.get(owner);
      if (entry) {
        entry.count += 1;
        entry.oldest = index;
      } else {
        owners.set(owner, { count: 1, oldest: index });
      }
    });
    let heaviest = 0;
    let oldest = -1;
    for (const entry of owners.values()) {
      if (entry.count > heaviest || (entry.count === heaviest && entry.oldest > oldest)) {
        heaviest = entry.count;
        oldest = entry.oldest;
      }
    }
    this.races.splice(oldest, 1);
  }

  list(limit: number): Promise<StoredRaceSummary[]> {
    return Promise.resolve(
      this.races.slice(0, limit).map(({ race: { log: _log, ...summary } }) => summary)
    );
  }

  get(id: string): Promise<StoredRace | null> {
    return Promise.resolve(this.races.find((stored) => stored.race.id === id)?.race ?? null);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

// A log is at most MAX_LOGGED_ACTIONS actions (checked on upload and before an online race is stored), about 90 KB: this
// keeps the table far under a free Neon database (0.5 GB) whoever uploads.
const MAX_STORED_RACES = 2000;

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
  'create index if not exists races_seq_idx on races (seq desc)',
  // #194: a table made before the device tokens has no column; null for the races the server stored itself.
  'alter table races add column if not exists device text',
  'create index if not exists races_device_idx on races (device, seq desc)'
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
    private migrationPool: Pick<pg.Pool, 'query' | 'end'> | null = null,
    private readonly limit = MAX_STORED_RACES,
    private readonly perDevice = MAX_RACES_PER_DEVICE
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
      `insert into races (id, source, track_id, rules_version, laps, cars, winner_car, log, device)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (id) do nothing`,
      [
        id,
        race.source,
        race.trackId,
        log.rulesVersion,
        log.raceLaps,
        log.seats.length,
        race.winnerCarId,
        JSON.stringify(log),
        race.device ?? null
      ]
    );
    if (race.device) {
      await this.pool.query(
        `delete from races where id in
           (select id from races where device = $1 order by seq desc offset $2)`,
        [race.device, this.perDevice]
      );
    }
    // The table is public and anonymous, so it stays under `limit` like the memory store.
    await this.evictOverLimit();
    return { id, duplicate: false };
  }

  // Plain selects and a delete by id, not one delete over a subquery: pg-mem deletes every matching row for that form
  // (it is right on Postgres), and `group by 1` crashes it (#206). `count(*)` is a string from `pg`.
  private async evictOverLimit(): Promise<void> {
    for (;;) {
      const total = await this.pool.query<{ n: string }>('select count(*) as n from races');
      if (Number(total.rows[0]?.n) <= this.limit) return;
      const owner = await this.pool.query<{ owner: string }>(
        `select coalesce(device, id) as owner from races
         group by coalesce(device, id) order by count(*) desc, min(seq) asc limit 1`
      );
      const victim = await this.pool.query<{ id: string }>(
        'select id from races where coalesce(device, id) = $1 order by seq asc limit 1',
        [owner.rows[0]?.owner]
      );
      const id = victim.rows[0]?.id;
      if (!id) return;
      await this.pool.query('delete from races where id = $1', [id]);
    }
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
