// Frozen: v1's move spend, copied from a97293a (src/game/systems/moveBudgetSystem.ts). Never edit (#118).
import { PIT_LANE } from '../../constants';

function isMainLane(laneIndex: number) {
  return laneIndex !== PIT_LANE;
}

export function computeMoveSpend(
  distance: number,
  startLaneIndex: number,
  targetLaneIndex: number,
  targetForwardDelta = distance
) {
  if (targetLaneIndex === PIT_LANE) return 1;
  const laneChangeSurcharge =
    isMainLane(startLaneIndex) &&
    isMainLane(targetLaneIndex) &&
    startLaneIndex !== targetLaneIndex &&
    targetForwardDelta >= distance
      ? 1
      : 0;
  return distance + laneChangeSurcharge;
}
