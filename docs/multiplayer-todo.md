# Multiplayer TODO

Execution backlog for authoritative multiplayer gameplay sync.

## Done

- [x] Resolve timeout policy conflict (v0 is manual turns + host force-skip, no auto-skip in v0).
- [x] Add `raceLaps` to multiplayer spec settings/state/win rules.
- [x] Define host-disconnect behavior (host disconnect ends lobby/race immediately).
- [x] Add protocol idempotency contract (`clientCommandId` + server dedupe semantics).
- [x] Specify deterministic seat rules (`seatIndex` assignment, bot seat fill, rematch seat persistence).
- [x] Define auth/scope for admin debug endpoint (dev-only vs protected prod access).
- [x] Clean up spec formatting for nested lists/readability.

## Priority 0: Core Sync Backbone

- [ ] Frontend opens authenticated websocket session (`/ws?lobbyId&playerToken`) after host/join.
- [ ] Frontend consumes and applies server events: `lobby.state`, `race.started`, `race.state`, `turn.applied`, `race.ended`.
- [ ] Add explicit websocket reconnect flow with lobby rehydrate on reconnect.

## Priority 1: Server Authoritative Race State

- [ ] Extend backend lobby model with authoritative `raceState` snapshot.
- [ ] Add/standardize server payload contracts to include `raceState` where relevant.
- [ ] On race start, initialize authoritative cars/turn order from deterministic seat assignment.
- [ ] Expose `race.state` snapshot on join/reconnect for state hydration.

## Priority 2: Authoritative Turn Engine

- [ ] Move turn application to backend (move/pit/skip mutates authoritative `raceState`).
- [ ] Enforce active-turn ownership (only active human seat owner may submit turn).
- [ ] Keep revision/idempotency behavior while applying real state mutations.
- [ ] Return deterministic stale/invalid turn errors without mutating state.

## Priority 3: Server Bot Authority

- [ ] Run bot turns only on backend.
- [ ] Broadcast bot-applied turns and resulting authoritative state.
- [ ] Keep bot decision traces server-side and queryable for debug.

## Priority 4: Client Rehydration and UX Safety

- [ ] Add client-side race scene hydrate/apply path from authoritative `raceState`.
- [ ] Disable local simulation paths when multiplayer authoritative mode is active.
- [ ] Gate local drag/drop input by server-authoritative active player.
- [ ] Show clear sync/reconnect status in UI.

## Priority 5: Validation

- [ ] Add backend contract tests for websocket event ordering and turn ownership enforcement.
- [ ] Add integration tests for two-client sync (host + guest).
- [ ] Add reconnect/resume tests (same token, same seat, hydrated state).
