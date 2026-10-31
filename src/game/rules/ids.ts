// The rules versions' names, with no engine code behind them: the page (main.ts) loads this eagerly, while the rules
// themselves (versions.ts) come with the lazily loaded game (#118).
export const RULES_VERSIONS = ['v3', 'v4'] as const;
export type RulesVersion = (typeof RULES_VERSIONS)[number];
export const DEFAULT_RULES_VERSION: RulesVersion = 'v4';

export function isRulesVersion(value: unknown): value is RulesVersion {
  return typeof value === 'string' && (RULES_VERSIONS as readonly string[]).includes(value);
}

/**
 * Why a race cannot be replayed, or null when it can. v1 and v2 were retired (#254): their races stay in the history
 * with their stats, but this build has no code to rebuild them.
 */
export function replayBlock(version: string): string | null {
  return isRulesVersion(version)
    ? null
    : `This race was played on rules ${version}, which were retired: it can no longer be replayed.`;
}
