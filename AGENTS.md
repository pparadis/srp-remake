# AGENTS.md

Project guide for Codex and other automation.

## Repo Overview

- Game prototype in `src/` (Phaser).
- Track data in `public/tracks/`.
- Tools in `tools/` (track generator + validation).
- Docs in `docs/`.

## Key Rules (Current)

- Movement is BFS on `next[]`. Forward progress ordering uses `forwardIndex`.
- No sideways lane changes: lane changes must advance `forwardIndex` (except `PIT_ENTRY`).
- Passing is blocked only by cars ahead in the **target lane** (adjacent lanes do not block).
- Pit lane rules:
  - Entry only via `PIT_ENTRY` from lane 1 (inner race lane).
  - Pit entry allowed only at distance 1 (no multi-zone jump).
  - Movement in pit lane is limited to 1 step, except if adjacent to a `PIT_BOX` you may target any `PIT_BOX` ahead.
  - Pit exit can connect to lane 1 (lane adjacency is not enforced for pit exit).

## Lap Counting

- Lap increments when `forwardIndex` wraps (from higher to lower) on non‑pit lanes.
- Decision made: no `START_FINISH` landing requirement; increment on wrap for non‑pit lanes.

## Debugging Tools

- In‑game debug:
  - Press `F` to toggle forwardIndex overlay.
  - “Copy debug” button copies a JSON snapshot with car + movement context.
- Snapshot includes `version` + `gitSha` for reproducibility.

## Validation & Tests

- Track validation: `node tools/validateTrack.mjs`
  - Checks spine lane existence, contiguous forwardIndex, and monotonic `next[]`.
- Tests: `npm test`
- CI: GitHub Actions runs validation, tests, and build (`.github/workflows/ci.yml`).

## Common Tasks

1. Regenerate track: `npm run gen:track`
2. Validate track: `node tools/validateTrack.mjs`
3. Run tests: `npm test`

## Troubleshooting

- If a test failure is reported, run `npm test` first to confirm the failure before using `npm run test:coverage`.
- From time to time, run `npm run build` to ensure the full build stays green.

## Conventions

- Use `forwardIndex` for ordering/progress, not `zoneIndex`.
- Keep next[] connectivity and BFS unchanged unless explicitly required.
