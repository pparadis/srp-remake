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
import { resourcesFor as v2Resources } from './v2/resources';
import { resourceRulesFor } from '../systems/resource_system';
import type { ResourceRules, ResourceRulesFor } from './resource_rules';
import { DEFAULT_RULES_VERSION, type RulesVersion } from './ids';

export { DEFAULT_RULES_VERSION, isRulesVersion, RULES_VERSIONS, type RulesVersion } from './ids';

export interface MovementRules {
  computeValidTargets: typeof computeValidTargets;
  computeSqueezeTargets: typeof computeSqueezeTargets;
  draftAhead: typeof draftAhead;
  resources: ResourceRulesFor;
  /** True from v4 (#138): each round the cars play in standing order, the leader first. */
  leaderFirst: boolean;
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
      resources: v2Resources,
      leaderFirst: false
    }
  },
  v2: {
    status: 'frozen',
    note: '#114 and #102: the draft gap in cells along the lane, cross-lane comparisons and lane-change prices by lap position, no cap on cars passed (tag rules-v2). Its code is copied in src/game/rules/v2/.',
    rules: {
      computeValidTargets: v2Movement.computeValidTargets,
      computeSqueezeTargets: v2Movement.computeSqueezeTargets,
      draftAhead: v2Draft.draftAhead,
      resources: v2Resources,
      leaderFirst: false
    }
  },
  v3: {
    status: 'frozen',
    note: '#148: car config and race management: compounds hard, medium and soft, a fuel load, wear sized to the race and to the move size (tag rules-v3). The default. Its code is the live movement, draft and resource systems.',
    rules: {
      computeValidTargets,
      computeSqueezeTargets,
      draftAhead,
      resources: resourceRulesFor,
      leaderFirst: false
    }
  },
  v4: {
    status: 'draft',
    note: '#138: v3 with the play order re-sorted by the standings at the start of each round, the leader first. Same movement, draft and resource code as v3 (nothing copied: only the turn loop differs).',
    rules: {
      computeValidTargets,
      computeSqueezeTargets,
      draftAhead,
      resources: resourceRulesFor,
      leaderFirst: true
    }
  }
};

/** The rules a race plays on. A state without a version (made before #118) plays the default. */
export function rulesOf(state: { rulesVersion?: RulesVersion | undefined }): MovementRules {
  return RULES[state.rulesVersion ?? DEFAULT_RULES_VERSION].rules;
}

/** The tire, fuel and move-size rules of a race: the version's, sized to the race's length. */
export function resourcesOf(
  state: { rulesVersion?: RulesVersion | undefined; raceLaps: number },
  trackIndex: { spineLen: number }
): ResourceRules {
  return rulesOf(state).resources({ raceLaps: state.raceLaps, spineLen: trackIndex.spineLen });
}
