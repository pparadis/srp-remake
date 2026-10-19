# Strategy readouts and game feel

## Strategy helpers (`src/game/systems/strategy.ts`, Phaser-free)

- `stintEstimate(car, spineLen)`: cells, laps and moves until tire or fuel reaches 0 at the car's compound,
  wing and PSI (middle lane, no safety margin). One move is taken as 8 cells (`MOVE_CYCLE`: 40 per 5 moves, plus
  the wing and compound pace: `cycleBudget(setup)`).
  The wear math is `wearPerCell` in `botPlan.ts`, which uses `setupFactors` from `movementSystem.ts`: there is
  one copy of it, shared by the engine costs, the bots, the HUD and the pit modal.
- `cellsToPitEntry(cell, plan)`: cells until the car stands on the lane-1 cell next to `PIT_ENTRY` (the only
  place a stop can start).
- `pitAdvice(car, cell, plan)`: `no-need` (serviced, final lap, or the car can finish as it is), `ok`,
  `pit-soon` ("Pit this lap") or `pit-now` (the entry is within one move). It is built on `stopIsDue` from
  `botPlan.ts`, the Normal bot's own stop timing, so the chip and the bot agree (a unit test sweeps both).
  It never advises a stop on the final lap (the pit lane is slow and the entry would have to be taken on the last lap).

## Race HUD additions

- Car card: "stint" line under the bars, the pit chip, and "Out of fuel: max 4 moves" when a resource is 0.
- Hover tooltip: `Move 7 - tire 63% → 58% - fuel ...`, each part coloured by the level it lands on; a move
  that empties tire or fuel adds a warning. Targets that leave tire or fuel under 20% get a red ring on the
  board (thicker when empty).
- Pit modal: stint of a fresh soft and hard set at the wing and PSI being edited, live. The same panel is the
  grid setup ("Setup" button next to Skip, until the car's first move).

## Feel

- `feelEvents.ts` diffs successive race snapshots into move, lap, low-resource, your-turn and finish events.
  The first snapshot only seeds it (also the first server state when joining or rejoining online), so a
  reload never fires a toast or a sound. Lap toasts, low-resource beeps and the your-turn ping are for the
  local player's car only; the finish (confetti and fanfare) is for everyone.
- The lap toast names the lap you just started ("Lap 2 / 5"), "Final lap" when the last lap starts. The first
  crossing of a car that started behind the line begins lap 1 silently; crossing after the last lap is the finish.

## Laps, for players

- A lap starts when you cross the start/finish line and the race ends when you cross it after the last lap, so
  every car drives the same distance. The grid is staggered: the front row sits on the line and is in lap 1 at once;
  cars in the rows behind show "Lap 0 / N" and "Cross the start line to begin lap 1" until their first crossing,
  which costs them the few cells to the line (a pole sitter really is a little ahead).
- The start line crosses the pit lane: a lap crossed there counts, as in F1, so a stop only costs the lost turn and the
  slow one-step pit lane (about 40 cells; the pit advice and the bots plan for that). A pit-lane crossing can end the
  race like any other.
- Confetti is a pool of Images of baked colour swatches (`Confetti.ts`) and removes itself after about 3.5 s.
  `__srp.freezeAnimations()` also stops it, for screenshots.
- Sound (`src/ui/sound.ts`) is a WebAudio synth without asset files. It stays silent until the first click
  or key press (autoplay policy), while muted, and in test builds. The "Sound: on/off" button in the HUD and
  the `M` key toggle it; the choice is kept in `localStorage["srp:muted"]`.

## Downforce (wing)

Three levels per car, `CarSetup.wing`: `low`, `medium`, `high` (`WING_EFFECTS` in `constants.ts`).

| wing   | cycle budget | tire wear | fuel wear |
| ------ | ------------ | --------- | --------- |
| Low    | +1           | x1.6      | x1.05     |
| Medium | 0            | x1        | x1        |
| High   | -1           | x0.8      | x0.9      |

The soft compound adds +1 to the cycle budget (`SOFT_PACE_BONUS`) and wears faster; the cycle budget is 40 on the
plain setup, so 39 to 42. Move cost per move is rounded to whole points as before, so the wing shows over a stint
rather than on one move. **Drafting** (see `docs/movement-spec.md`, issues #83, #93 and #98): a car is in the tow when its last move ended 1-2
cells behind a car in its lane. The car card shows "In the tow 1/2" and then "In the tow - slingshot ready"; the compact
phone bar shows a short chip instead ("» DRAFT 1/2", gold "» SLINGSHOT"; `.hud-draft-short`, 11px so the bar stays one
line), which pulses once when it appears and when the count goes up (none under `prefers-reduced-motion`).

On the board:

- **Tows:** a few faint streaks from each car in a tow (every car's, not only yours) along its lane to the car ahead,
  only while that car is still there (once it has moved on the streaks would lead to nothing; the card and the targets'
  rings still say you are in the tow): blue while counting, gold when the slingshot is open
  (`RaceSession.draftLinks()`, `RaceScene.drawTow()`; redrawn on a turn change and hidden while cars glide).
- **Targets:** a move that ends 1-2 behind a car in its lane has a blue dashed ring (`RaceSession.endsTucked`, the
  `tuck` layer in `bakedTextures.ts`); a slingshot target has a gold ring, doubled when only the slingshot puts it in
  reach (`TargetInfo.slingshotOnly`).
- **Tooltip and tap card:** "Draft: less wear", "Ends in the tow: less wear next move", "Slingshot: the lane change is
  free" or "Slingshot: only in reach thanks to the draft".

Moments (`feelEvents.ts`, the local car only, never on the first snapshot): "In the tow: less wear" (a blue toast and a
soft sound) when a move ends tucked in, "Slingshot ready" when the run reaches 2, and "Slingshot!" when one is played
(`Car.slingshots` going up). The feed says "Car N slingshots." (the engine log solo; online the session reads it from
the counter in the server state). The data comes from `RaceSession.hudSnapshot()` (`drafting`, `draftTurns`).

## Cars on the board move like cars (issue #85)

The race state is already final when the board draws it (the bots play synchronously in solo, a server state can carry
several turns), so the scene animates the difference:

- `RaceSession.drainMoves()` lists the cars that changed cell since the last call, in the order they moved (solo: each
  applied action; online: the cars whose cell differs from the previous state, in turn order starting with the car that
  was on turn then).
- `RaceScene.syncTokens()` glides those cars one after another (`glideTo`): along `movePath` (round the cars standing
  where they stood when it moved), through a `Phaser.Curves.Path` with a counter tween, turning with the road. A glide
  takes `glideDuration(steps)` (about 0.2 to 0.5 s) and a whole round is squeezed into about 1.5 s (`glide.ts`).
- **Dragging (#110):** the car turns with the road under the finger: each drag event eases its body a third of the way
  to the heading of the nearest cell (`easeAngle`, the short way round; off the track it keeps its rotation; always the
  direction of travel, never towards the finger). A valid drop is not snapped onto the cell: the move goes to the engine
  and `glideTo` glides the token from where it was dropped, easing its rotation to the cell's heading (a token put down by
  hand has no road under it, so no `movePath`). A refused drop (not an offered cell, not allowed) glides back to its own
  cell the same way (`resolvePlayerDragDrop`'s `onReturn`). A pit drop still snaps and opens the modal. A tap (Move here)
  glides from the car's own cell, online at once while the server answers.
- Input is never held for a glide: the logical state is final, targets are computed from it, and a glide that is
  interrupted by the next move ends on its cell first.
- Off: the e2e build (specs read where cars are; `?anim` turns it on, `e2e/glide.spec.ts`), `prefers-reduced-motion`,
  and a frozen screenshot (`freezeAnimations`).

### Camera: zoom, pan, follow (issue #87)

- The fit (`centerTrack`: the track between the HUD panels) is unchanged and stays the default. The player's view sits on
  top of it (`src/game/scenes/rendering/cameraView.ts`, Phaser-free, tested): a zoom factor from 1 (fitted) to 3, capped
  at 3x on a dense screen, and a pan in world units that may not take the free area's edges past the track's box plus a
  margin (none at the fit: the fitted track does not move).
- Input (`registerCameraGestures.ts`): two fingers pinch (the world point under them stays under them), one finger on the
  empty board pans once it has moved past the tap slop (a press on a car or a button never pans, and a tap still selects a
  target at any zoom), the wheel zooms about the pointer, a double tap on the empty board fits again, and so does the
  `Fit` button (a canvas button next to Skip, shown only while zoomed in).
- Follow: when the player's car is on turn again and has moved since it was last centred, the camera brings it to the
  middle of the free area, as far as the pan limit allows (`RaceScene.maybeFollowMyCar`). Solo has no "your turn
  begins" event (the bots play inside the refresh), hence the cell test. Only while zoomed in.
- `window.__srp.view()` (test hook): the player's zoom, the camera's zoom and whether `Fit` shows.
- The page itself must not zoom: `touch-action: none` on `#app`, and a `gesturestart` guard for iOS Safari.

### Preview and trail (issue #86)

- **Preview:** the path of the move about to be made, drawn as a line along the road in the target lane's colour (gold
  for a slingshot, amber for a squeeze, yellow for a pit stop) under a dark edge. The target is the picked one (a tap),
  else the one under the pointer (hover, or the dragged car). `RaceSession.previewFor(hoverCellId)` gives it (path
  round the other cars, straight through them for a squeeze); `RaceScene.drawPreview()` redraws on hover or target
  change only, never per frame.
- **Trail:** each car's last move as a thin line in its colour, drawn when it sets off, fading to a faint line that stays
  until that car moves again. `RaceSession.lastMovePath(carId)` keeps it (solo: each applied action; online: the diff
  of two server states, round the cars as they stood). Drawn faint and without a fade under `prefers-reduced-motion`,
  and not at all in the e2e build (screenshots) unless `?anim`. The `C` key hides both with the targets.
- `window.__srp.overlays()` (test hook) returns the preview and the trails as drawn.
- **Following a car (issue #135):** click a car's row in the standings, or tap its car on the board, to follow it: the
  race feed shows only its lines ("Race feed · Car 3"), a panel lists its moves over its last lap (lap, cells, move
  points, tire and fuel used, pit stops) and the board draws that lap as a faint white line with a dot where each move
  ended. Click or tap it again, or "All cars", to stop. A tap near one of your own targets still picks the target.

The grid setup is the `setup` action (compound, pressures, wing; free, once, before the car's
first move; it does not end the turn; `setup_locked` after that). Positions saved with two wing angles load as
Medium (`normalizeSetup` in `sandbox.ts`).
