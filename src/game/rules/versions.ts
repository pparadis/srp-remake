// Movement rules versions (#118). A race is played on one version (`RaceState.rulesVersion`), chosen when it is
// created and never changed. What a version holds is only what differs between versions: the target search (prices,
// blockers, squeeze), the draft test and the resource rules (tire, fuel and move size, #148). Everything else (next[]
// connectivity, pit, laps, bots) is shared.
//
// A frozen version never changes behavior: its code is never edited and its golden file
// (src/game/rules/golden/<version>.json, made by tools/rules_golden.ts) fails rules_golden.test.ts if it moves.
// Changing a frozen version's behavior means a new version. A draft version changes freely.
import { computeSqueezeTargets, computeValidTargets } from '../systems/movement_system';
import { draftAhead } from '../systems/draft_system';
import * as v1Movement from './v1/movement_system';
import * as v1Draft from './v1/draft_system';
import * as v2Movement from './v2/movement_system';
import * as v2Draft from './v2/draft_system';
import { resources as v2Resources } from './v2/resources';
import type { ResourceRules } from './resource_rules';
import { DEFAULT_RULES_VERSION, type RulesVersion } from './ids';

export { DEFAULT_RULES_VERSION, isRulesVersion, RULES_VERSIONS, type RulesVersion } from './ids';

export interface MovementRules {
  computeValidTargets: typeof computeValidTargets;
  computeSqueezeTargets: typeof computeSqueezeTargets;
  draftAhead: typeof draftAhead;
  resources: ResourceRules;
}

export const RULES: Record<
  RulesVersion,
  { status: 'frozen' | 'draft'; note: string; rules: MovementRules }
> = {
  v1: {
    status: 'frozen',
    note: 'Before #114: every distance from forwardIndex (tag rules-v1, a97293a). Kept for reference, not online.',
    rules: {
      computeValidTargets: v1Movement.computeValidTargets,
      computeSqueezeTargets: v1Movement.computeSqueezeTargets,
      draftAhead: v1Draft.draftAhead,
      resources: v2Resources
    }
  },
  v2: {
    status: 'frozen',
    note: '#114 and #102: the draft gap in cells along the lane, cross-lane comparisons and lane-change prices by lap position, no cap on cars passed (tag rules-v2). Its code is copied in src/game/rules/v2/.',
    rules: {
      computeValidTargets: v2Movement.computeValidTargets,
      computeSqueezeTargets: v2Movement.computeSqueezeTargets,
      draftAhead: v2Draft.draftAhead,
      resources: v2Resources
    }
  },
  v3: {
    status: 'draft',
    note: '#148: car config and race management. Starts equal to v2; its code is the live movement and draft systems.',
    rules: { computeValidTargets, computeSqueezeTargets, draftAhead, resources: v2Resources }
  }
};

/** The rules a race plays on. A state without a version (made before #118) plays the default. */
export function rulesOf(state: { rulesVersion?: RulesVersion | undefined }): MovementRules {
  return RULES[state.rulesVersion ?? DEFAULT_RULES_VERSION].rules;
}
