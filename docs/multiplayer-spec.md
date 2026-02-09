# Multiplayer Spec (Draft)

This document captures a first-pass design for online multiplayer with a direct lobby link.

## Goals

- Let players join the same race via a shared URL.
- Keep gameplay rules identical to single-player.
- Keep configurable race length (`raceLaps`) identical to single-player.
- Support flexible grid composition (`humans-only` and `humans + bots`).
- Keep turn resolution deterministic and debuggable.

## Non-Goals (v0)

- Ranked matchmaking.
- Public server browser.
- Spectator mode.
- Cross-race persistence (profiles, stats, progression).

## Product Flow

1. Host clicks `Create Online Lobby`.
2. Client requests a new lobby and receives a link like `/lobby/:lobbyId`.
3. Host shares the link.
4. Other players open link and join lobby.
5. Host sets options (`track`, `totalCars`, `humanCars`, `botCars`, `raceLaps`).
6. Host starts race.
7. All clients transition into the same race and receive synchronized state updates.

## Recommended Architecture

Use authoritative server + websocket clients.

Why this fits:

- Turn-based game means low bandwidth and simple action protocol.
- Server authority prevents client-side cheating and desync.
- Rejoin/resume is straightforward by replaying authoritative state.

## Alternative Options

1. `Node + WebSocket` (recommended)

- Full control, easiest to evolve for custom rules.
- Requires running a backend service.

2. `Firebase/Firestore + Presence`

- Fast to ship for lobby and state sync.
- More constraints for turn validation and custom server logic.

3. `WebRTC host-authority`

- No dedicated server for gameplay packets.
- Host migration, NAT traversal, and trust model become harder.

## Lobby Model

Suggested server entity:

```ts
type Lobby = {
  lobbyId: string;
  status: "WAITING" | "IN_RACE" | "FINISHED";
  hostPlayerId: string;
  createdAt: number;
  updatedAt: number;
  settings: {
    trackId: string;
    totalCars: number;
    humanCars: number;
    botCars: number;
    raceLaps: number;
  };
  players: Array<{
    playerId: string;
    name: string;
    connected: boolean;
    seatIndex: number | null;
    isHost: boolean;
  }>;
};
```

## Seat Model (v0)

- Seats are indexed `0..(totalCars-1)` and are authoritative on the server.
- Host is always assigned `seatIndex = 0`.
- Additional humans are assigned the lowest available seat index at join time.
- During an active race, seat ownership is stable (no seat reshuffle).
- Turn order is derived from ascending `seatIndex`.
- Spawn/car identity is derived from ascending `seatIndex` (`carId = seatIndex + 1`).
- Human cars use the owning player seat.
- Bot seats fill all remaining unoccupied seats in ascending `seatIndex`.
- Rematch in same lobby keeps seat ownership for players still present, removes seats for leavers, then fills free seats with reconnecting/new humans first and bots second (ascending `seatIndex`).

## Identity Decision (v0)

Chosen approach: `anonymous nickname + server-issued session token`.

Rationale:

- Lowest join friction for direct-link lobbies.
- Fastest path to playable multiplayer.
- Supports reconnect without introducing account/auth flows yet.

### Token Lifecycle (v0)

1. On first join, client submits nickname and receives `playerId` (lobby-scoped identity) and `playerToken` (opaque secret).
2. Client stores `playerToken` in local storage.
3. On reconnect, client sends `lobbyId + playerToken`.
4. Server maps token to existing player seat and restores control.
5. Tokens are invalidated when the lobby expires, host destroys the lobby, or player is removed/kicked.

### Security Constraints (v0)

- Token must be high-entropy and unguessable.
- Never expose token in URLs or logs.
- Use short TTL for inactive lobbies.
- Rotate token on explicit leave/rejoin if needed.

## Match Model

Authoritative match state should include:

- `cars[]` with `isBot`, fuel/tire, pit state.
- `turnState` and `activeCarId`.
- `trackId`.
- `raceLaps` and `winnerCarId | null`.
- `rngSeed` if any random behavior is introduced.
- `revision` integer incremented after each accepted action.

## Network Protocol (Draft)

Client -> Server:

- `lobby.create`
- `lobby.join`
- `lobby.updateSettings`
- `lobby.startRace`
- `turn.submitMove`
- `turn.submitPitStop`
- `turn.skip`
- `heartbeat`

Server -> Client:

- `lobby.state`
- `lobby.playerJoined`
- `lobby.playerLeft`
- `race.started`
- `race.state`
- `turn.applied`
- `error`

Payload requirement for v0:

- `lobby.create` / `lobby.updateSettings` must include `raceLaps`.
- `lobby.state`, `race.started`, and `race.state` must include `raceLaps`.
- `turn.submitMove`, `turn.submitPitStop`, and `turn.skip` must include `clientCommandId` (UUID-like).
- `turn.applied` should echo `clientCommandId` when action originated from a client.

## Idempotency Contract (v0)

- `clientCommandId` is generated client-side per submitted turn action.
- Command id uniqueness scope: unique per `playerId` for the lifetime of a lobby.
- Server stores a dedupe cache keyed by `(lobbyId, playerId, clientCommandId)`.
- If a duplicate command is received, server must not apply state twice and must return the previously computed result (`turn.applied` or `error`) for that command id.
- If `revision` no longer matches current state, server rejects with deterministic stale-action error; duplicate stale commands must return the same stale-action payload.

## Turn Authority Rules

- Server validates every action using the same movement/pit rules.
- Only the active human player can submit a move.
- Bot turns run only on the server.
- Server enforces win when a car reaches `raceLaps`.
- Client UI is optimistic only if paired with rollback on reject.
- For v0, prefer non-optimistic updates to simplify correctness.
- Turn timeout policy for v0: no automatic timer-based skip, host can force-skip active player, and timer auto-skip stays out of scope.

## Reconnect Behavior

- Player identity stored in `playerToken`.
- On reconnect, client sends token and lobby id.
- Server rebinds socket to player and sends full latest `race.state`.
- If disconnected player is active, race pauses until the player reconnects or host force-skips.

## Host Disconnect Policy (v0)

- If host disconnects at any time, the current race/lobby is ended immediately.
- Server broadcasts terminal state with reason: `host_disconnected`.
- Clients return to out-of-race UI and must create/join a new lobby to continue.

## Anti-Cheat and Integrity

- Never trust client-computed valid targets.
- Server recomputes valid targets from authoritative state.
- Rate-limit action submissions.
- Reject stale actions using `revision` checks.
- Enforce idempotency using `(playerId, clientCommandId)` dedupe.

## UX Notes

- Show lobby code and one-click copy link.
- Show ready/connected status per player.
- Show reconnect banner if socket drops.
- Disable local drag controls when it is not the player's turn.

## Observability

- Add `matchId`, `lobbyId`, `revision`, `turnIndex` to logs.
- Keep bot decision logs server-side and fetch on demand.
- Add a lightweight admin endpoint to dump current authoritative state.

## Admin Debug Endpoint Scope (v0)

- Endpoint is intended for debugging operations only (not gameplay clients).
- Default policy: disabled in production.
- If explicitly enabled in production, require HTTPS, static admin bearer token (`Authorization: Bearer <token>`), rate limit, request audit logging, and secret redaction (`playerToken`, auth headers) from payload/logs.
- Recommended endpoint shape: `GET /admin/lobbies/:lobbyId/state`.

## Deployment Notes

- GitHub Pages can host the web client only.
- Real-time multiplayer still needs a backend endpoint (WebSocket/SSE/HTTP).
- Practical setup: frontend on GitHub Pages, backend on Fly.io/Render/Railway (or equivalent).
- Transport policy for v0: keep WebSocket + REST only; do not add SSE unless production/network constraints prove WS reliability issues.

## V0 Decisions (Locked)

1. Identity: `anonymous nickname + playerToken`.
2. Turn timeout: `manual turns only + host force-skip`.
3. Lobby privacy: `unguessable UUID direct link`.
4. Race restart: `rematch in same lobby with same players`.
5. Auto-skip timer: `not in v0` (revisit in v1+).
6. Lap target: `host-configurable raceLaps`, authoritative on server.
7. Host disconnect: `end lobby/race immediately` ("if he dies, he dies").
8. Action idempotency: `clientCommandId + server dedupe cache` is required for turn submissions.
9. Seat model: `deterministic seatIndex-driven spawn + turn order + rematch preservation`.
10. Admin endpoint: `disabled in prod by default`; if enabled, require bearer auth + HTTPS.
11. Transport fallback: `SSE deferred`; revisit only if concrete WebSocket compatibility issues appear in production-like environments.

## Delivery Plan

1. Phase 1: Lobby-only vertical slice

- Create/join by link.
- Presence list and host controls.
- No race start yet.

2. Phase 2: Authoritative race start

- Server initializes state and broadcasts it.
- Clients render read-only synchronized state.

3. Phase 3: Human turns online

- Submit/validate/apply moves server-side.
- Broadcast `turn.applied`.

4. Phase 4: Bot turns server-side

- Reuse existing bot system on backend.
- Broadcast bot actions with decision trace ids.

5. Phase 5: Reconnect and timeout policy

- Rejoin flow.
- Document timeout policy for post-v0 (optional auto-skip).

## Implementation Checklist (From Locked Decisions)

1. Add host-only `Force Skip Active Player` action in race UI and server API.
2. Ensure lobby ids are high-entropy UUID-like tokens and never sequential.
3. Keep lobby roster/settings alive across race end and expose `Rematch`.
4. On rematch, reset match state while preserving players and host.
5. Document inactivity TTL for lobbies and token invalidation behavior.
6. Persist and rebroadcast `raceLaps` for lobby state, race start, and rematch.
7. On host disconnect, close the lobby and broadcast terminal reason `host_disconnected`.
8. Add `(playerId, clientCommandId)` dedupe storage and replay same result for duplicate submits.
9. Implement authoritative seat assignment and bot-fill rules based on ascending `seatIndex`.
10. Gate admin state-dump endpoint behind environment flag and bearer-token auth.
