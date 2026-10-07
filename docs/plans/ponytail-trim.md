# Ponytail trim

Status: Done (PR #21, follow-up PR #24)

Result of a repo-wide over-engineering audit. Small, behaviour-neutral cuts.

## Done on this branch

- Remove the `eslint-plugin-import` dev dependency (both its rules were `"off"`).
- Unexport symbols nothing outside their file uses (types, `toShortBotDecisionLogEntry`, `PIT_EXIT_SQUEEZE_RANGE`); drop the unused `TrackSchema` type.
- Ignore `.claude/worktrees/` in git.

## Follow-up (done)

After PR #19 merged: unexported the remaining unused symbols (`hud.ts`, `backendApi.ts`, the bot and bench types,
`GameOptions`, `CarState`, `LobbyStatus`, `mix`) and replaced the `TextButton` class with a `makeButton` function
(`src/game/scenes/ui/makeButton.ts`) that returns the Phaser text object.

Not done: folding `tools/track/*.mjs` into `tools/genOval16_3lanes.mjs` (optional, a one-off tool).
