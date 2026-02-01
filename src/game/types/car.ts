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

export interface Car {
  carId: number;
  ownerId: string;
  cellId: string;
  tire: number;
  fuel: number;
  setup: CarSetup;
  state: CarState;
  pitTurnsRemaining: number;
  pitExitBoost: boolean;
  pitServiced: boolean;
  moveCycle: {
    index: number;
    spent: number[];
  };
}
