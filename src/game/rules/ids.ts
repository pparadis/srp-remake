// The rules versions' names, with no engine code behind them: the page (main.ts) loads this eagerly, while the rules
// themselves (versions.ts) come with the lazily loaded game (#118).
export const RULES_VERSIONS = ["v1", "v2"] as const;
export type RulesVersion = (typeof RULES_VERSIONS)[number];
export const DEFAULT_RULES_VERSION: RulesVersion = "v2";

export function isRulesVersion(value: unknown): value is RulesVersion {
  return typeof value === "string" && (RULES_VERSIONS as readonly string[]).includes(value);
}
