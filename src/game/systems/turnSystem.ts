import type { Car } from "../types/car";

export interface TurnState {
  order: number[];
  index: number;
}

export function createTurnState(cars: Car[], startIndex = 0): TurnState {
  return {
    order: cars.map((c) => c.carId),
    index: Math.max(0, Math.min(startIndex, Math.max(0, cars.length - 1)))
  };
}

export function getCurrentCarId(state: TurnState): number | null {
  if (state.order.length === 0) return null;
  return state.order[state.index] ?? null;
}

export function advanceTurn(state: TurnState): void {
  if (state.order.length === 0) return;
  state.index = (state.index + 1) % state.order.length;
}
