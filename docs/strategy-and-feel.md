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
- Confetti is drawn with Phaser graphics (`Confetti.ts`) and removes itself after about 3.5 s.
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
rather than on one move. The grid setup is the `setup` action (compound, pressures, wing; free, once, before the car's
first move; it does not end the turn; `setup_locked` after that). Positions saved with two wing angles load as
Medium (`normalizeSetup` in `sandbox.ts`).
