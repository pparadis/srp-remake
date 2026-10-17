// Movement rules versions (#118). A race is played on one version (`RaceState.rulesVersion`), chosen when it is
// created and never changed. What a version holds is only what differs between versions: the target search (prices,
// blockers, squeeze) and the draft test. Everything else (next[] connectivity, pit, laps, wear, bots) is shared.
//
// A frozen version never changes behavior: its code is never edited and its golden file
// (src/game/rules/golden/<version>.json, made by tools/rulesGolden.ts) fails rulesGolden.test.ts if it moves.
// Changing a frozen version's behavior means a new version. A draft version changes freely.
import { computeSqueezeTargets, computeValidTargets } from "../systems/movementSystem";
import { draftAhead } from "../systems/draftSystem";
import * as v1Movement from "./v1/movementSystem";
import * as v1Draft from "./v1/draftSystem";

export const RULES_VERSIONS = ["v1", "v2"] as const;
export type RulesVersion = (typeof RULES_VERSIONS)[number];
export const DEFAULT_RULES_VERSION: RulesVersion = "v2";

export interface MovementRules {
  computeValidTargets: typeof computeValidTargets;
  computeSqueezeTargets: typeof computeSqueezeTargets;
  draftAhead: typeof draftAhead;
}

export const RULES: Record<RulesVersion, { status: "frozen" | "draft"; note: string; rules: MovementRules }> = {
  v1: {
    status: "frozen",
    note: "Before #114: every distance from forwardIndex (tag rules-v1, a97293a). Kept for reference, not online.",
    rules: {
      computeValidTargets: v1Movement.computeValidTargets,
      computeSqueezeTargets: v1Movement.computeSqueezeTargets,
      draftAhead: v1Draft.draftAhead
    }
  },
  v2: {
    status: "draft",
    note: "#114: the draft gap in cells along the lane, cross-lane comparisons and lane-change prices by lap position.",
    rules: { computeValidTargets, computeSqueezeTargets, draftAhead }
  }
};

export function isRulesVersion(value: unknown): value is RulesVersion {
  return typeof value === "string" && (RULES_VERSIONS as readonly string[]).includes(value);
}

/** The rules a race plays on. A state without a version (made before #118) plays the default. */
export function rulesOf(state: { rulesVersion?: RulesVersion | undefined }): MovementRules {
  return RULES[state.rulesVersion ?? DEFAULT_RULES_VERSION].rules;
}
