---
name: online-sessions
description: Online play and backend guide: turn timer, lobby settings (every site a new one must reach), rename, race length limit, race history and device tokens, host grace, chat, player tokens, hardening and rate limits. Read before changing backend/, src/net or the lobby screens.
---

# Online Sessions

- Turn timer: lobby setting `turnTimerSec` (0|30|60|120, default 60). On expiry the server plays the stuck
  human's turn with the `"autopilot"` bot policy (`src/game/systems/bot_system.ts`, deliberately mediocre; it is also the weakest rung of the benchmark); the
  host can force it with `POST /lobbies/:id/force-skip`. A plain skip is illegal while moves exist.
- A new lobby setting must be threaded through every site: `backend/src/types.ts`, the zod patch schema AND
  `toSettingsPatch` in `server.ts`, `DEFAULT_SETTINGS` + `normalizeSettings` in `lobby_store.ts`, the client type
  in `src/net/backend_api.ts`, `index.html`, `src/main.ts`, and tests that assert on settings.
- Rename (#78): every player has a "Racing as" field in the lobby card (`lobby-name`); `PATCH /lobbies/:id/player`
  `{ name }` (same 1-32 name rule, 60 a minute, 401 bad token, 409 once the race has started: names are
  copied into the race) broadcasts `lobby.state`. The name goes to `srp:name` and the home field, so a reload rejoins
  with it. A guest with no saved name gets the field focused with a hint, after the join's busy state clears (a
  disabled field cannot take focus). Not `/join`: that is the reconnect path. A player with no saved name gets a
  Docker-style one (`src/ui/player_name.ts`, "steady_hairpin"), kept in `srp:name` and flagged `srp:name-auto` until
  they pick one, so the guest hint still shows for it.
- Race length (#211): one limit, `MAX_RACE_LAPS` (50) in `src/game/race/limits.ts`, for the lobby settings schema,
  `lobby_store.ts`, the Laps field and the upload's `raceLogSchema`. A log over `MAX_LOGGED_ACTIONS` (2000) is the byte
  bound of a history row: the page does not upload a solo race over it ("Too long to share") and `storeOnlineRace`
  skips it with a warning, since the row cap counts rows, not bytes.
- Race history (#170): `backend/src/race_store.ts`, a `RaceStore` (`insert`, `list`, `get`): `MemoryRaceStore` without
  `DATABASE_URL`, `PgRaceStore` (Neon) with it; both keep at most 500 races in memory, 2000 in Postgres (the table is public
  and anonymous, so one uploader must not fill the database). Over the limit the store drops the oldest race of the owner
  holding the most: an owner is a device, or a race with no device (an online one) on its own, and a tie goes to the owner
  whose oldest race is oldest. So a script that mints tokens takes races from its own tokens, not from real players'.
  Written as plain selects and a delete by id: pg-mem deletes every matching row for a delete over a `limit 1` subquery
  and crashes on `group by 1`, which real Postgres runs fine (#206 plans real-Postgres store tests). Anonymous: a race is its scrubbed log (`scrubLog` replaces the owner ids,
  no names). The server stores each finished online race after the broadcast (not awaited, a failure is logged) and
  `POST /api/v1/races` takes a solo race, replaying it with `replayRace` first. The id is a hash of the log, so a
  race is stored once. Device tokens (#194): `POST /api/v1/devices` (20 a day per IP) gives an anonymous token signed
  with `DEVICE_TOKEN_SECRET` (`backend/src/device_token.ts`, stateless, no account), `POST /api/v1/races` needs it as
  `Authorization: Bearer` (401 before any replay), and the store keeps `deviceHash(id)` in a `device` column, never
  given back, with at most `MAX_RACES_PER_DEVICE` (50) races per device (the next replaces its own oldest). The client
  keeps the token in `localStorage["srp:device"]` (`BackendApiClient.uploadRace` mints it, and on a 401 takes a new one
  and retries once). Tested with `pg-mem` standing in for Postgres (it differs from Postgres on `returning` after
  `on conflict do nothing`, so duplicates are found by a select first). On Neon: `DATABASE_URL` is the pooled URL (the
  app's queries), `DATABASE_URL_UNPOOLED` the direct one (only the `create table`); `neon.ts` / `.neon` / `.env.local`
  are the Neon CLI's (`.neon` and `.env.local` stay out of git); work against the `dev` branch, not `production`.
  The solo upload is on by default and can be turned off: the "Share my races anonymously" checkbox of the Quick race
  card (`srp:share-solo`: only an explicit `0` means off; solo only) makes `main.ts` send each finished solo race with
  `backendClient.uploadRace` after the results are up (`results-shared` says how it went; a failure never touches the
  local recap; a sandbox race has no log, so nothing goes). Online races need no setting: the server stores them. The public history is browsed at `/history` (home button "Public race history",
  `src/ui/history_page.ts`, `backendClient.listRaces`); `/history/:id` and `/history/:id/board` are the same recap and
  board replay as `/recap/:id`, with `remote: true` on the route: the race comes from `backendClient.readRace` instead
  of this browser's `localStorage`, is not saved there, and names its cars by seat (the log holds no names).
- Host reload keeps the lobby for `HOST_GRACE_SECONDS` (default 45). Sockets are tracked per player. Every socket is
  pinged every 30 s and one that has not answered the last ping is terminated, so a phone that dropped off the network
  becomes "disconnected" (and starts the host grace) instead of holding its lobby open for good.
- Test-only clocks: `TURN_TIMER_TIME_SCALE` (e.g. 0.1 makes "120 s" last 12 s) and `HOST_GRACE_SECONDS`;
  `playwright.config.ts` sets both for the backend it starts (e2e `createLobby` defaults the timer to Off).
  A reused local backend with real clocks breaks `e2e/afk.spec.ts`: use `E2E_BACKEND_PORT`.

- Chat (#70): `POST /lobbies/:id/chat` (1 message/s per player, last 50 kept per lobby, `chat.message` and
  `chat.history` on the socket, never inside `PublicLobby`). The text rule is `src/game/chat_text.ts` (100 graphemes,
  400 UTF-16 units), shared by the client and the server. The panel is `src/ui/chat.ts`: one element that `main.ts`
  moves between the lobby card and the race HUD; messages go in with `textContent` only. Keys typed in any form field
  are skipped by `onKeyDown` and the C/M handler (`isTypingTarget`). Solo has no chat.
- Player token in a header (#194 step 3): every lobby route reads it from `Authorization: Bearer` through
  `playerTokenOf` in `server.ts` (the header wins; none, or over 64 characters, is a 401), so a new lobby route calls
  that and never reads `playerToken` from its body or query. `BackendApiClient` sends it that way (`bearer()`), `start`,
  `reset` and `force-skip` take no body, and the WebSocket keeps `?playerToken=` (a browser sets no header on one). For
  one release the body and query fields still work, for a page loaded before the deploy: then delete the
  `optionalPlayerTokenSchema` fields, `playerTokenOf`'s second argument, the `legacy` half of
  `backend/test/player_token.contract.test.ts` and the old-form usages in the other contract tests. Who is asking is
  answered in one place (#213): `LobbyStore.requirePlayer(lobbyId, token, onInvalidToken?)` (lobby 404, token 401) and
  `requireHost(lobbyId, token, notHostMessage)` (then host 403). A new route or store method calls one of them and
  checks the lobby's state (409, #208) after, so a stranger learns nothing about the race; a route that logs a rejected
  token passes the logging as `onInvalidToken`. The websocket connect keeps its own check (it closes with a reason
  instead of throwing). `backend/test/lobby_store.test.ts` pins the order.
- Backend hardening (#69): request logs redact `playerToken` (`redactTokens`); lobbies with no open socket are reaped
  (`LOBBY_IDLE_SECONDS`, finished ones after 10 min); inputs are bounded (names 32, body 16 KiB, WS frames 1 KiB,
  `MAX_LOBBIES`); routes are rate limited per IP (`@fastify/rate-limit`, limits at the route in `server.ts`, keyed by
  `clientIpOf`). On Render the socket is always `127.0.0.1`, so the limits were one world-wide bucket until #210: set
  `CLIENT_IP_HEADER=cf-connecting-ip` there (the edge sets it and refuses a client-set one); never `TRUST_PROXY=true`,
  which takes the client's own `X-Forwarded-For` entry. Tests and e2e run with `RATE_LIMIT_ENABLED` off (a partial test config is off too); the
  limit and reaper tests are in `backend/test/hardening.contract.test.ts`. See `docs/backend-render-deploy.md`.
