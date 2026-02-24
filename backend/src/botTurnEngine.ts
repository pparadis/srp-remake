import type { RaceCarState, RaceState, TurnSubmitAction } from "./types.js";

export type BotTurnTrace = {
  policyVersion: string;
  reason: string;
  seatIndex: number;
  carId: number;
  turnIndex: number;
  activeSeatIndex: number;
};

export type BotTurnDecision = {
  action: TurnSubmitAction;
  trace: BotTurnTrace;
};

export function decideBotTurnAction(raceState: RaceState, activeCar: RaceCarState): BotTurnDecision {
  // v0 authoritative backend state does not include movement/pit target computation yet.
  // Keep a deterministic server-owned action policy and log a structured trace for debugging.
  return {
    action: { type: "skip" },
    trace: {
      policyVersion: "v0.skip_only",
      reason: "movement_targets_unavailable_in_backend_state",
      seatIndex: activeCar.seatIndex,
      carId: activeCar.carId,
      turnIndex: raceState.turnIndex,
      activeSeatIndex: raceState.activeSeatIndex
    }
  };
}
