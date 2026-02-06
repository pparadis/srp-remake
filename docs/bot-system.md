# Bot System Spec (v0)

This document defines a **basic heuristic bot** system for the current turn-based race prototype.

## Goals

- Provide functional AI opponents without changing core movement rules.
- Keep the bot logic deterministic and easy to test.
- Allow bots to fill empty slots or run in a dedicated bot mode.

## Non-Goals (v0)

- Advanced racing strategy (blocking, drafting).
- Long-term optimization or learning.
- UI parity with player drag controls.

## Modes

- **Fill empty slots:** When player count exceeds connected humans, spawn bots to fill remaining slots.
- **Bot mode:** A dedicated mode that spawns bots (with optional single human).

## Turn Execution

- Bots **resolve moves instantly** (no drag simulation).
- Resolution uses the same movement system and validation as players.

## Bot Decision Model

Bots follow a simple heuristic per turn:

1. Compute valid targets via `computeValidTargets(...)`.
2. Discard targets disallowed by game state (pit boxes disallowed after service).
3. Score remaining targets with a heuristic and choose the highest.
4. If no valid targets, bot **skips**.

### Heuristic Score (v0)

Each candidate target receives a score:

- **Primary:** `distance` (higher is better).
- **Secondary:** prefer **lower total cost** (tireCost + fuelCost).
- **Pit preference:**
  - If tire or fuel is below a threshold, prefer `PIT_BOX` targets.
  - Otherwise, lightly penalize `PIT_BOX` targets.

Suggested defaults:

- Low resource threshold: `tire <= 25` or `fuel <= 25`
- Pit penalty when not low: `-2`
- Tie-breaker: lowest `tireCost + fuelCost`, then lowest `cellId` for determinism.

### Example Scoring (pseudo)

```
score = distance * 10 - (tireCost + fuelCost)
if isPitTrigger:
  if lowResources: score += 5
  else: score -= 2
```

## Data & State

- Bots use the same `Car` model.
- A bot is identified by a flag (e.g. `isBot: true`) or by `ownerId` prefix.
- Bot actions should be logged the same way as player actions.

## Integration Points

- **Turn flow:** on bot turn, call `computeValidTargets`, pick a target, and call `applyMove` or `recordMove(0)` to skip.
- **UI:** bot turns should still update `validTargets` and log output, but no drag input.
- **Mode selection:** add a registry flag for bot mode (e.g. `REG_BOT_MODE`).

## Testing

Add unit tests for:

- Bot selects the furthest target when resources are healthy.
- Bot prefers pit box when resources are low.
- Bot skips when no valid targets.
- Bot respects `disallowPitBoxTargets` after service.

## Future Improvements

- Lookahead for blocking or pit timing (see `docs/bot-lookahead-spec.md`).
- Per-track strategy tuning.
- Different bot personalities (aggressive, conservative).

## Implementation Checklist

1. [x] Add bot identity (`isBot`) to `Car`.
2. [x] Add mode flags for bot mode + fill‑slots behavior.
3. [x] Spawn bots to fill missing slots and/or in bot mode.
4. [x] Implement `pickBotMove(...)` heuristic function.
5. [x] Integrate bot turn execution in the turn loop.
6. [x] Ensure logging and UI updates for bot actions.
7. [x] Add tests for heuristic choices and skip behavior.
