// Bot difficulty; one level applies to every bot in a race.
export const BOT_LEVELS = ["easy", "normal", "hard"] as const;
export type BotLevel = (typeof BOT_LEVELS)[number];

export type CarState = "ACTIVE" | "PITTING" | "WAITING" | "DNF";

export interface CarSetup {
  compound: "soft" | "hard";
  psi: {
    fl: number;
    fr: number;
    rl: number;
    rr: number;
  };
  wingFrontDeg: number;
  wingRearDeg: number;
}

import type { MoveCycle } from "../systems/moveBudgetSystem";

export interface Car {
  carId: number;
  ownerId: string;
  isBot: boolean;
  // Only set on bots; read by decideBotAction when no explicit policy is passed.
  botLevel?: BotLevel;
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
}
