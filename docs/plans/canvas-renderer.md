# Switch Phaser to the Canvas renderer (everywhere)

Status: Done (PR #17, merged)

## Context
`src/game/index.ts` uses `type: Phaser.AUTO`, which means WebGL in practice. The game is a turn-based board (lines,
a few sprites, text), and the HUD is already DOM. The goal is a simple renderer that is easy on the browser.

PR #16 measured CPU seconds of the browser over an idle race plus 3 turns:
- software WebGL at 60 fps: 125.6 s;
- WebGL with the 10 fps test cap that PR #16 shipped: 47.1 s;
- **Canvas at 60 fps: 8.8 s**;
- Canvas at 15 fps: 3.4 s.

The PR did not adopt Canvas for two reasons: (a) 2 screenshot baselines change (about 12 pixels each), and (b) e2e
would no longer exercise the WebGL renderer used in production. Using Canvas in production too removes (b): e2e
then tests exactly what ships.

Nothing in `src/game` needs WebGL: no tint, FX, pipelines, shaders, masks, blend modes or particles. Every API in use
works on Canvas: Graphics, text, image, tileSprite, ellipse/circle, container, tweens, camera zoom, and
`Graphics.generateTexture` for the baked track (`RaceScene.drawTrack`).

## Steps
1. `src/game/index.ts`: `type: Phaser.AUTO` → `type: Phaser.CANVAS`. Keep the 10 fps test cap, because it still
   lowers e2e load. Reword its comment: it says "software WebGL burns many CPU cores", which won't be true after
   this change.
2. Update the wording in `AGENTS.md`:
   - the "Verification → Why" line ("software WebGL") should say Canvas;
   - add one line: the game uses Phaser's Canvas renderer on purpose (light, turn-based); do not add WebGL-only
     features (tint, FX, shaders).
3. Regenerate the 2 baselines and look at them before committing:
   `e2e/track.spec.ts-snapshots/race-start-chromium-linux.png` and
   `e2e/hud.spec.ts-snapshots/race-hud-chromium-linux.png`. Use the single-spec command from AGENTS.md with
   `--update-snapshots`.
   - If local WSL pixels differ from CI, regenerate the baselines in CI instead.

Not doing: a renderer switch flag, and removing the inert `resolution` cast. Add the flag only if a device turns out
slower on Canvas.

## Verification (per the AGENTS.md policy; full e2e only in CI)
- `npm test`, `npm run test:coverage`, `npm run lint`, `npm run build`.
- e2e locally: `smoke`, `track` and `hud` specs only.
- Optional: `npm run probe:cpu` to confirm the CPU drop.
- Manual: `npm run dev`, start a quick race, and check that `game.renderer.type === 1` (CANVAS). Check zoom/pan
  smoothness (the 4000×3000 grass tileSprite), hover, move highlights, the car tween and the lap toast.
- Open a PR and watch CI with `gh run watch`.
