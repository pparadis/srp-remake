# Ponytail trim

Status: Done (PR #21)

Result of a repo-wide over-engineering audit. Small, behaviour-neutral cuts.

## Done on this branch

- Remove the `eslint-plugin-import` dev dependency (both its rules were `"off"`).
- Unexport symbols nothing outside their file uses (types, `toShortBotDecisionLogEntry`, `PIT_EXIT_SQUEEZE_RANGE`); drop the unused `TrackSchema` type.
- Ignore `.claude/worktrees/` in git.

## Deferred until PR #19 (`feat/bot-personalities`) merges

It touches these files, so cutting them now would conflict:

- `src/ui/hud.ts`: unexport `renderTooltip`, `lapText`, `HudHover`.
- `src/net/backendApi.ts`: unexport `REQUEST_TIMEOUT_MS` and the `*Response` types.
- `src/game/systems/botSystem.ts`, `src/game/race/botBench.ts`, `botHard.ts`: unexport `Bot*`, `Bench*`, `HardDeps` types.
- `src/game/scenes/ui/TextButton.ts`: replace the class with a `makeButton` function (call site in `RaceScene.ts`).
- `src/game/index.ts`, `src/game/types/car.ts`, `backend/src/types.ts` (`LobbyStatus`): unused exported types.

Optional: fold `tools/track/*.mjs` into `tools/genOval16_3lanes.mjs`.
