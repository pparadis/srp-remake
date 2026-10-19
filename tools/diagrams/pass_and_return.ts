// Diagram: pass and return (docs/movement-spec.md, "Occupancy"): a same-lane target beyond the nearest car, reached by
// going round it through ONE adjacent lane and rejoining; the route pays for both lane changes. Same drawing as the
// lane-change price: the route is the engine's, the price is the rule's and the engine's.
import type { RaceContext } from '../../src/game/race/race_engine';
import { laneChangePriceSvg, type RouteCopy } from './lane_change_price';
import type { Scenario } from './scenario';

// You and a car ahead on lane 1; the target is in your own lane, two cells beyond the car.
export const PASS_AND_RETURN_SCENARIO: Scenario = {
  start: 'Z12_L1_00',
  cars: ['Z14_L1_00'],
  target: 'Z16_L1_00',
  zones: [11, 16]
};

const COPY: RouteCopy = {
  title: 'Pass and return: round a car through one adjacent lane, and back',
  intro: "One real route on the oval's bend"
};

export function passAndReturnSvg(ctx: RaceContext): string {
  return laneChangePriceSvg(ctx, PASS_AND_RETURN_SCENARIO, COPY);
}
