# Multiplayer Spec

Design and current status of online multiplayer with a direct lobby link. The "Status" section at the end lists what is built; the protocol section describes the real REST + WebSocket API.

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
5. Host sets options (`track`, `totalCars`, `humanCars`, `botCars`, `raceLaps`, `turnTimerSec`).
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
    turnTimerSec: 0 | 30 | 60 | 120; // 0 = no limit, default 60
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
2. Client stores the session (`lobbyId`, `playerId`, `playerToken`) in `sessionStorage` under `srp:session:{lobbyId}`: it survives a reload of the tab (which rejoins with the same token) but a second tab is a new player.
3. On reconnect, client sends `lobbyId + playerToken` (`POST /join` with `playerToken`, then the WebSocket).
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

## Network Protocol

REST under `/api/v1` (JSON), plus a WebSocket at `/ws?lobbyId=&playerToken=` for server pushes. Commands
are always REST; the socket only carries events to the client.

REST:

- `GET /health` (also used by the client to wake a sleeping server).
- `POST /lobbies` `{ name, settings? }` creates a lobby (`201`, returns `playerId` + `playerToken`).
- `GET /lobbies/:lobbyId?playerToken=` reads the lobby (`401` for a bad token, `404` unknown lobby).
- `POST /lobbies/:lobbyId/join` `{ name?, playerToken? }` joins, or rejoins with a token.
- `PATCH /lobbies/:lobbyId/settings` `{ playerToken, settings }` (host, while `WAITING`).
- `POST /lobbies/:lobbyId/start` `{ playerToken }` (host).
- `POST /lobbies/:lobbyId/reset` `{ playerToken }` (host, play again).
- `POST /lobbies/:lobbyId/force-skip` `{ playerToken, revision? }` (host): the server plays one autopilot
  turn for the active human seat. `401` bad token, `403` non-host, `404` unknown lobby, `409` unless the race
  is `IN_RACE` with a human seat to play (or `revision` is stale).
- `POST /lobbies/:lobbyId/turns` `{ playerToken, clientCommandId, revision, action }` where `action` is
  `{ type: "move", targetCellId }`, `{ type: "pit", targetCellId, setup }` or `{ type: "skip" }`.

WebSocket events (server -> client): `lobby.state`, `race.started`, `race.state` (all carry the full public
lobby, including `raceState`), `turn.applied` and `race.ended`.

- `raceState.turnRemainingMs` is the time the active human seat has left, measured by the server (no
  client clock sync needed); it is absent when the timer is Off or a bot is on turn.
- `turn.applied` carries `clientCommandId`, `revision`, `applied` and a `source`: absent/`human` for a
  player, `bot` for a bot seat, `timeout` when the turn timer auto-played a seat, `force_skip` when the host
  did.

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
- Turn timer (built): the host picks `turnTimerSec` in the lobby (Off / 30 s / 60 s default / 2 min). When
  the active human seat runs out of time the server plays its turn with the **autopilot**, then arms the
  timer for the next human. The autopilot is deliberately mediocre so engaged players always do better: it
  picks the legal non-pit target closest to the median distance, prefers the current lane, never pits (unless
  a pit box is the only reachable cell) and skips only when there is no target. A plain `skip` is illegal
  while moves exist (`moves_available`), so the timeout has to be a move.
- Host force-skip (built): the host plays the same autopilot turn immediately (`POST /force-skip`).
- Timers are per lobby, `unref()`'d, cleared on finish, reset, termination and server close, and re-check the
  lobby status and `revision` before acting. `TURN_TIMER_TIME_SCALE` (env, test-only) shrinks timer lengths.

## Reconnect Behavior

- Player identity stored in `playerToken`.
- On reconnect, client sends token and lobby id.
- Server rebinds socket to player and sends full latest `race.state`.
- Sockets are tracked per player: a player is `connected` while at least one socket is open, so an old
  socket closing after a reconnect does not mark a live player as gone.
- If a disconnected player is active, the turn timer still runs and auto-plays their seat (or the host
  force-skips). With the timer Off the race waits for them.
- The client shows a "Reconnecting..." banner while its socket is down, and a "Waking the server..." banner
  when a request takes more than 3 s (free-plan cold start, ~50 s). Requests time out after 90 s. A failed
  rejoin only drops the stored session on `401`/`404`, never on a network error.

## Host Disconnect Policy (v0)

- When the host's last socket closes (often just a page reload) the lobby is kept for a grace period,
  `HOST_GRACE_SECONDS` (default 45). Others see the host as disconnected ("Host disconnected" banner).
- If the host reconnects (WebSocket open) within the grace period, the timer is cancelled and nothing else
  changes. (The REST rejoin alone does not cancel it: the host has to get a socket back.)
- Otherwise the race/lobby is ended: the server broadcasts terminal state with reason `host_disconnected`,
  revokes tokens and closes the sockets with `4001`. Clients return to out-of-race UI and must create/join a
  new lobby to continue.

## Anti-Cheat and Integrity

- Never trust client-computed valid targets.
- Server recomputes valid targets from authoritative state.
- Rate-limit action submissions (not built yet).
- Reject stale actions using `revision` checks.
- Enforce idempotency using `(playerId, clientCommandId)` dedupe.

## UX Notes

- Show lobby code and one-click copy link.
- Show ready/connected status per player.
- Show reconnect banner if socket drops (built: `connection-banner`).
- Disable local drag controls when it is not the player's turn.

## Observability

- Add `matchId`, `lobbyId`, `revision`, `turnIndex` to logs.
- Never log player tokens; use a short hash (`tokenFingerprint`) instead.

## Deployment Notes

- GitHub Pages can host the web client only.
- Real-time multiplayer still needs a backend endpoint (WebSocket/SSE/HTTP).
- Practical setup: frontend on GitHub Pages, backend on Fly.io/Render/Railway (or equivalent).
- Transport policy for v0: keep WebSocket + REST only; do not add SSE unless production/network constraints prove WS reliability issues.

## V0 Decisions (Locked)

1. Identity: `anonymous nickname + playerToken`.
2. Turn timeout: `host-chosen turn timer (autopilot move on timeout) + host force-skip`.
3. Lobby privacy: `unguessable UUID direct link`.
4. Race restart: `rematch in same lobby with same players`.
5. Auto-play timer: `built` (see Turn Authority Rules); a plain skip is not possible while moves exist.
6. Lap target: `host-configurable raceLaps`, authoritative on server.
7. Host disconnect: `end lobby/race after a grace period` (`HOST_GRACE_SECONDS`, default 45) so a reload survives.
8. Action idempotency: `clientCommandId + server dedupe cache` is required for turn submissions.
9. Seat model: `deterministic seatIndex-driven spawn + turn order + rematch preservation`.
10. Transport fallback: `SSE deferred`; revisit only if concrete WebSocket compatibility issues appear in production-like environments.

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

- Rejoin flow (built).
- Turn timer, force-skip and host grace period (built).

## Status

Built:

- Lobby create/join by link, deterministic seats, bot seat fill, `raceLaps` setting.
- Player tokens with expiry; host disconnect ends the lobby and revokes tokens.
- Turn submission with `revision` checks, `clientCommandId` dedupe and active-seat ownership.
- The server is authoritative over the race: it runs the shared race engine (`src/game/race`), so every
  move, pit stop (with its setup) and skip is validated against the real rules. An illegal action is refused
  with `409 invalid_action` + a `reason` and changes nothing.
- The server runs the bots (same heuristic as single-player), counts laps and ends the race at `raceLaps`
  (`race.ended` with `winnerCarId`).
- The public `raceState` carries full car state (cell, tire, fuel, setup, pit state, move budget, laps), and
  the client renders it as-is (non-optimistic: input is locked until the server answers).
- WebSocket sync (`lobby.state`, `race.started`, `race.state`, `turn.applied`, `race.ended`) with client
  reconnect and rehydrate.
- Play again: `POST /api/v1/lobbies/:lobbyId/reset` (host only, body `{ playerToken }`) returns a lobby that
  finished by `race_finished` to `WAITING` (race state, winner and `terminationReason` cleared, `revision`
  bumped; players, tokens and settings kept) and broadcasts `lobby.state`. `409` if the lobby is not
  `FINISHED` or was closed (host disconnect: tokens are revoked, it stays dead); `403` for a non-host.

- Rejoin after a page reload: the session lives in `sessionStorage` (per tab) and `POST /join` with the token
  restores the seat; the socket reconnects with backoff and rehydrates.
- Turn timer (`turnTimerSec`, host-selectable), autopilot auto-play on timeout, host force-skip route and
  button, `turnRemainingMs` countdown in the HUD, `source` on `turn.applied`.
- Host grace period (`HOST_GRACE_SECONDS`) instead of ending the lobby on the first host socket close.
- Per-player socket tracking.
- Client UX: connection banner (reconnecting, host away, waking the server), background `/health` wake-up and
  a 90 s request timeout.
- Rematch ("play again") keeps every player and seat; it does not reshuffle seats or drop leavers.

Not built yet:

- Rate limiting of turn submissions.
- Rematch seat reshuffling (leavers removed, late joiners filling free seats).
- Pausing the countdown while a player is reconnecting (the timer keeps running by design).
