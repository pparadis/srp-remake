# Multiplayer TODO

Saved follow-up items from spec review.

## Done

- [x] Resolve timeout policy conflict (v0 is manual turns + host force-skip, no auto-skip in v0).
- [x] Add `raceLaps` to multiplayer spec settings/state/win rules.
- [x] Define host-disconnect behavior (host disconnect ends lobby/race immediately).
- [x] Add protocol idempotency contract (`clientCommandId` + server dedupe semantics).

## Remaining

- [ ] Specify deterministic seat rules (`seatIndex` assignment, bot seat fill, rematch seat persistence).
- [ ] Define auth/scope for admin debug endpoint (dev-only vs protected prod access).
- [ ] Clean up spec formatting for nested lists/readability.
