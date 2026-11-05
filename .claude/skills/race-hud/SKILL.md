---
name: race-hud
description: Race screen guide: WebGL renderer, frame rate, baked textures, the DOM HUD, phones and tap to move, car setup, race feed, follow a car, glides, camera, move preview, sounds. Read before changing src/game/scenes, src/ui/hud.ts, style.css or anything the player sees in a race.
---

# Race HUD

- The game renders with Phaser's WebGL only (`type: Phaser.WEBGL` in `src/game/index.ts`; why, and what it costs:
  `docs/adr/0001-webgl-only-renderer.md`; decisions of this size get an ADR in `docs/adr/`). The Canvas renderer
  and its `?renderer=canvas` switch were removed (#237): the last commit with them is the git tag `canvas-renderer`. It
  is a turn-based board, and software WebGL costs about 5x the CPU of Canvas (Phaser 4.2.1, `npm run probe:cpu`: 2.1 s
  against 10.3 s for an idle solo race plus a few turns), so a machine with no GPU acceleration is slow and has no
  fallback. The e2e suite and its pixel baselines run on WebGL (software GL on CI is deterministic);
  `e2e/smoke.spec.ts` asserts the canvas holds a WebGL context, and `e2e/webgl.spec.ts` plays a race to the end and
  starts another (leaving the race screen hides the container, 0x0, which a WebGL framebuffer cannot be:
  `keepGameSizeInSync` ignores a container with no size) and loses and restores the WebGL context mid-race (the board
  must look the same after; our baked textures come back by themselves). A browser with no WebGL gets a sentence on
  the home screen (`ui/webgl_support.ts`, asked once per page for the `webgl` context Phaser requests, and checked
  before the game chunk loads and before a lobby is hosted or joined), not a Phaser error. A real GPU is not measured yet (#232).
- Idle frame rate (#82): the game starts with an fps limit and `FrameGovernor` (`src/game/frame_governor.ts`, created by
  `RaceScene`) moves Phaser's `_limitRate` between full speed (1 ms, never 0: Phaser 4 keeps `delta % _limitRate`, and
  a 0 made it NaN and stopped the loop for good, #232) and 15 fps (`FRAME_RATES`). Full speed on any pointer, key,
  wheel or `srp:` event of the page (`watch`) and while `RaceScene.isAnimating()` says a glide, the camera tween, confetti
  or the pit modal moves, then 600 ms after. The halo pulse and a trail's fade do not count (they look stepped at the
  idle rate). A new animation that must be smooth goes through a tween, a timer-free thing the check can see; a new input
  source that changes the board without a pointer or `srp:` event needs its event in `WAKE_EVENTS`. The e2e (`test`) build
  keeps its fixed 10 fps cap (both rates 10), so `npm run probe:cpu` cannot show the adaptive rate: measure it with a
  temporary build override and the `P` readout (idle about 13 fps, a drag 60). Measured: 11.4 s of CPU for a 15 s idle race
  plus 3 turns uncapped, 3.8 s adaptive.
- Never draw a large texture every frame: the grass is the CSS background of `#app` behind a transparent canvas
  (`transparent: true`, `style.css`), not a Phaser `tileSprite`. A 4000x3000 `tileSprite` was redrawn each frame and
  Firefox on a real display (X11) fell to 9 fps while Chromium was at 60 (#79; headless Firefox did not show it, so
  check a real window with the `P` readout). Draw big static layers once (the track is baked with `generateTexture`).
- Sharpness on phones (on by default since #157, `?hidpi=0` turns it off): Phaser 3.90 has no `resolution` option, so
  the canvas would be 1x and a phone stretches it (blurry). `main.ts` reads the flag once and passes it to `startGame`:
  the game uses `Scale.NONE` with a canvas `renderScale()` times its container (`src/game/hidpi.ts`, capped at 3) shown
  at `zoom: 1 / renderScale()`; `keepGameSizeInSync` resizes it. Scene code works in canvas pixels: CSS sizes are
  multiplied by `renderScale()` and every `add.text` style takes `resolution: textResolution()` and
  `fontFamily: UI_FONT` (`src/game/ui_font.ts`, the system monospace: SF Mono on iOS, the generic `monospace` is
  Courier there; `style.css` uses the same stack); both scales are 1 at dpr 1 or with `?hidpi=0`. The first try (#58) left the race scene blank on an
  iPhone 17 (reverted in #59); it runs there since #88. A bare `?hidpi` also shows a probe line
  (`src/ui/diagnostics.ts`). Uncaught errors always show in the `crash-report` box (phones have no console).
- What repeats is baked once, never drawn or rasterised per frame (#88): the track at `renderScale()` pixels per unit
  (`drawTrack`: `generateTexture` replays `scaleCanvas`, shown at `1 / k`, so `?hidpi` is sharp), and the target rings,
  car bodies, number badges and confetti swatches as canvas textures (`rendering/baked_textures.ts`, at `renderScale()`
  times 2 so a 3x pinch stays sharp). Target rings and costs are pooled (`ui/target_markers.ts`); a new marker kind is a
  layer in `targetLayers`, not a Graphics call.
- The HUD (car card, turn banner, standings, hover tooltip, race feed, results table) is DOM, not canvas:
  `src/ui/hud.ts` renders the `srp:hud` snapshot that `RaceSession.hudSnapshot()` builds (`RaceScene.emitHud()`
  sends it). Add HUD data to the snapshot there; keep `hud.ts` free of Phaser. The grid setup menu is DOM too (`src/ui/setup_panel.ts`, #159: a modal over the HUD that
  scrolls on a short screen; its edits are `src/game/systems/setup_edit.ts`, shared with the pit modal). The pit modal
  (until its move, #159 step 2), Skip and Copy debug buttons stay in the canvas.
- Phones (issue #49): the page is sized with `100dvh` (`body` in `style.css`; `100vh` is only the fallback): on iOS
  Safari `100vh` is the screen without the browser bars, and `overflow: hidden` would cut off the bottom of the race
  screen while they show. Phaser can stay at the old size after a phone rotation (its `orientationchange` handler eats
  the size change), so `keepGameSizeInSync` (`src/game/game_size.ts`) re-applies the container's size to the game. The
  race screen is landscape-only (portrait shows `hud-rotate`). Under `(max-height: 500px)`
  (`COMPACT_HUD_QUERY` in `src/ui/layout.ts`, same query in `style.css`) the car card is a top bar, standings and the
  feed sit in a drawer (`hud-drawer-toggle`) and the canvas hides its debug buttons. Each HUD panel says where it takes
  room from the track with the `--hud-dock` CSS property; `RaceScene.centerTrack()` fits the track to what is left
  (`hudGutters`). Tap to move: a tap on the board (no drag) picks the nearest target in reach
  (`RaceSession.selectTarget`, cleared on every turn change); the HUD card's Move here / Cancel send
  `srp:hud-command`, and Move here goes through the same path as a drop (`resolvePlayerDragDrop`). Drag still works.
  Copying a cell id on press only happens with the F overlay on. `e2e/mobile.spec.ts` covers it. Add to Home Screen:
  `public/manifest.webmanifest` (fullscreen, landscape, relative URLs so the Pages base works) and the iOS tags in
  `index.html`; icons in `public/icons/` are rendered from `icon.svg` by `npm run gen:icons`. No service worker.
- Car setup (#48, #148): `CarSetup.wing` is `low | medium | high` (`WING_EFFECTS` in `constants.ts`); on v3 also
  `compound` `hard | medium | soft` (`COMPOUND_TABLE`: cap, cycle budget, tire life) and `fuelLoad` (a multiple of 5, 40 to
  100; missing = 100). The cycle budget, cap and wear of a car are `resourcesOf(state, trackIndex)`'s (v3: the compound's
  budget plus the wing, minus 1 while the tank holds over `HEAVY_FUEL`; wear sized to the race length, by move points 7 /
  8 / 9, rounded to 0.1), never `MOVE_CYCLE.budget` for a car. The `setup` action (grid setup, before the first move, not
  a turn) sets it and `car.fuel = fuelLoad`; a stop refuels to `max(fuel, fuelLoad)`. Bots set up in `createRace` with
  `bestSetup`; the human's panel opens by itself on its first turn on v3. A change to the numbers must keep
  `npx tsx tools/bot_bench.ts --setups` (and `--rules v3`) passing the gate (`docs/bot-system.md`).
- Race feed (#92): `src/game/systems/race_feed.ts` (`feedLines(ctx, before, after, name)`, pure) turns the difference between
  two race states into `{ text, kind, carId }` lines (move, pass, lap, pit, warn, finish, info). Solo calls it after each
  action (`RaceSession.addFeed`, with a clone of the state before) and online after each server state, so both say the same.
  The engine has no log of its own; `HudSnapshot.log` carries `{ text, kind, mine }` and `hud.ts` styles by kind. The feed
  starts open except in the compact (phone) layout. A rule or resource that should be said goes in `feedLines`, with a case in
  `race_feed.test.ts`.
- Follow a car (#135): a click on its standings row (`srp:hud-command` `follow-car`) or a tap on its token
  (`RaceScene.tapBoard`: a target in reach wins, and the token the player may drag is never followed) calls
  `RaceSession.followCar` (again: stop; "All cars" too). The session keeps 500 feed lines and shows the last 30, only the
  followed car's (`carId`) while one is followed. It also keeps each car's last 24 moves (`CarMove`: cells, move points,
  tire/fuel used, pit, the `movePath`), recorded where `lastPaths` is (solo and online alike, from the state diff; online the
  move points come from the car's move cycle, `-` when it rolled over). `lastLapMoves` keeps those that ended within
  `spineLen` cells of the car; `HudSnapshot.follow` lists them and `RaceScene.drawFollowedCar()` draws them (a faint white
  line, dots, a ring round the car; `C` hides it). Page-only: an online reload starts it empty. Sandbox edits clear it.
- Strategy readouts (stint estimate, pit chip, result-aware tooltip, pit-modal stints) come from
  `src/game/systems/strategy.ts`, which reuses the bots' wear math in `bot_plan.ts`: do not write a second copy.
- Cars glide to their cells (#85): `RaceSession.drainMoves()` gives the cars that moved, in order, and
  `RaceScene.syncTokens()`/`glideTo` animate them along `movePath` (`src/game/systems/move_path.ts`, visual only: never
  feeds rules). Instant in the e2e build (`?anim` turns it on) and under `prefers-reduced-motion`; a spec that reads
  token positions right after a turn relies on that. A dragged car turns with the road under the finger (`easeAngle`,
  #110), a dropped drag glides from the drop point and a refused one glides back. Details: `docs/strategy-and-feel.md`.
  The glides of one round run one after another: each starts when the one before ends or is stopped (`glideTo`'s
  `afterCarId`, a paused tween resumed), not after a summed `delay`, which overlapped by about a frame (Phaser spends
  a tween's first frame starting it, #232).
  The race is ahead of the board (the bots play at once, the cars glide after), so nobody acts until the last glide has
  ended (#189): `syncTokens` sets `RaceSession.setCarsMoving(true)` when it starts glides, which makes
  `canControlActiveCar` / `localCanControl` / `canSkip` / `canSetup` false and hides the rings (`HudSnapshot.carsMoving`:
  "The other cars are moving"), and the scene's `UPDATE` hook calls `settleBoard()` once `glides` is empty (targets, halo,
  banner, the grid setup offer, the "your turn" chime). Input never waits on a flag the scene can lose: it is the glides.
- Camera (#87): the fit (`centerTrack`) plus the player's zoom 1 to 3 and pan (`rendering/camera_view.ts`, pure and
  tested); pinch, pan, wheel, double tap and the `Fit` button in `input/register_camera_gestures.ts`; the camera follows
  the player's car after its move while zoomed. The camera's matrix is refreshed at once (`cam.preRender()`) so a tap
  right after a pinch lands right. Details: `docs/strategy-and-feel.md`.
- Move preview and trail (#86): `RaceSession.previewFor()` (the path of the picked or hovered target) and
  `lastMovePath()` (each car's last move) feed `RaceScene.drawPreview()`/`showTrail()`; both reuse `movePath`.
- Feel: lap toast, finish confetti and sounds are driven by `src/game/systems/feel_events.ts` through
  `RaceSession.drainFeel()` (`RaceScene.reactToRace()` plays them); the first snapshot must never fire. Sound is `src/ui/sound.ts` (WebAudio, muted in
  test builds); `M` or the HUD button mutes, stored in `localStorage["srp:muted"]`. Details: `docs/strategy-and-feel.md`.
