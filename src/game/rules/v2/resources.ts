// Frozen: tire, fuel and move size as v2 and v1 play them, with their constants copied in (#148). Never edit; v3
// changes systems/resource_system.ts. A cap of 9 (4 when a tire or the tank is empty), a cycle budget of 40 plus the
// wing plus 1 for soft, a full refill at every stop, soft and hard only.
import { SETUP_LIMITS, WING_EFFECTS, WING_LEVELS } from '../../constants';
import type { ResourceRules, ResourceRulesFor } from '../resource_rules';

const MOVE_RATES = { softTire: 0.5, hardTire: 0.35, fuel: 0.45 } as const;
const MOVE_CAP = { base: 9, empty: 4 } as const;
const CYCLE_BUDGET = 40;
const SOFT_PACE_BONUS = 1;

export const resources: ResourceRules = {
  isValidSetup(setup) {
    const { psi } = SETUP_LIMITS;
    const psiOk = [setup.psi.fl, setup.psi.fr, setup.psi.rl, setup.psi.rr].every(
      (v) => Number.isInteger(v) && v >= psi.min && v <= psi.max
    );
    const compoundOk = setup.compound === 'soft' || setup.compound === 'hard';
    return compoundOk && setup.fuelLoad === undefined && psiOk && WING_LEVELS.includes(setup.wing);
  },
  moveCap(car) {
    return car.tire === 0 || car.fuel === 0 ? MOVE_CAP.empty : MOVE_CAP.base;
  },
  defaultSetup(dealt) {
    return dealt;
  },
  cycleBudget({ setup }) {
    return (
      CYCLE_BUDGET +
      WING_EFFECTS[setup.wing].pace +
      (setup.compound === 'soft' ? SOFT_PACE_BONUS : 0)
    );
  },
  wearRates(setup) {
    const tireRate = setup.compound === 'soft' ? MOVE_RATES.softTire : MOVE_RATES.hardTire;
    return { tireRate, fuelRate: MOVE_RATES.fuel, setup };
  },
  sizeFactor() {
    return { fuel: 1, tire: 1 };
  },
  gridSetup(car, setup) {
    car.setup = structuredClone(setup);
  },
  pitService(car, setup) {
    car.tire = 100;
    car.fuel = 100;
    if (setup) car.setup = setup;
  },
  features: { medium: false, fuelLoad: false }
};

/** v1 and v2 size nothing to the race. */
export const resourcesFor: ResourceRulesFor = () => resources;
