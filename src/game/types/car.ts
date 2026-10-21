// Bot difficulty; one level applies to every bot in a race.
export const BOT_LEVELS = ['easy', 'normal', 'hard'] as const;
export type BotLevel = (typeof BOT_LEVELS)[number];

type CarState = 'ACTIVE' | 'PITTING' | 'WAITING' | 'DNF';

export interface CarSetup {
  // 'medium' and `fuelLoad` exist from rules v3 on; v1 and v2 refuse them.
  compound: Compound;
  // Fuel at the grid, an integer percent (a multiple of 5, 40 to 100). Missing means a full tank.
  fuelLoad?: number | undefined;
  psi: {
    fl: number;
    fr: number;
    rl: number;
    rr: number;
  };
  wing: WingLevel;
}

import type { Compound, WingLevel } from '../constants';
import type { MoveCycle } from '../systems/move_budget_system';

export interface Car {
  carId: number;
  ownerId: string;
  isBot: boolean;
  // Only set on bots; read by decideBotAction when no explicit policy is passed.
  botLevel?: BotLevel;
  // Bench/test override of the seed-derived personality (a PersonalityKey); never set in real races.
  style?: string;
  cellId: string;
  lapCount?: number;
  tire: number;
  fuel: number;
  setup: CarSetup;
  state: CarState;
  pitTurnsRemaining: number;
  pitExitBoost: boolean;
  pitServiced: boolean;
  moveCycle: MoveCycle;
  // True once the car has played a turn; the grid setup (compound, wing) can only change before that.
  setupLocked?: boolean;
  // Consecutive turns this car has begun in a draft (see draftSystem): the slingshot needs DRAFT_SLINGSHOT_TURNS.
  draftTurns?: number;
  // Slingshot moves this car has played (a counter, so a client can tell from two states that one just landed).
  slingshots?: number;
}
