---
name: race-recap
description: Recap and replay guide: replaySteps, raceRecap, the recap page and its routes, saved races, the online recap route, the board replay and its bar. Read before changing src/ui/recap_*, replay_*, race_recap.ts or how a finished race is saved.
---

# Race recap and replay

- `replaySteps` gives each step's before, after and engine
  result; `raceRecap(ctx, log, nameOf)` (`src/game/systems/race_recap.ts`) turns that into the recap data: per car
  (place, grid setup, pit choices, moves with exact move points, passes) and per turn (the feed lines too, from
  `feedLines`). The recap page (`src/ui/recap_page.ts`, route `/recap/:id`, screen `recap`) shows the summary, a car's
  moves and pit choices and the turn by turn; names go in with `textContent`. A finished solo race is saved by
  `main.ts` (`saveRace` in `src/ui/recap_store.ts`: the last 10 in `localStorage["srp:races"]`, the scene sends the log
  in `srp:race-finished`), listed on the home screen and opened from the results screen; `recap_load.ts` builds the
  recap lazily so the engine is not in the first bundle. Online: `GET /lobbies/:id/recap` (bearer player token) gives `{ log,
names, trackId }` to a seated player once somebody has won (409 before, 401 bad token); the client asks for it as
  `srp:race-finished` arrives (`saveOnlineRace` in `main.ts`) and saves it like a solo race, so the Recap button shows
  once it is there. Reading a recap keeps the online session: Back returns to the lobby. The board replay (route
  `/recap/:id/board`, "Watch on the board" on the recap page) runs the race scene as a spectator of an online race:
  `replay_load.ts` dresses every replayed state as the server's lobby state (round-trips through `toEngineRace`), and
  `main.ts` sends them as `srp:backend-lobby-state` (`localPlayerId` empty: nobody is in control) from the replay bar
  (buttons, Left/Right, Play: `src/ui/replay_bar.ts`, #202; `main.ts` keeps `openReplay`, which opens the game; a public
  race becomes a `SavedRace` in `src/ui/remote_race.ts`). While a replay runs the live online events are not forwarded to the scene and the scene's
  `srp:race-finished` is ignored. Stepping back is a state change like any other: the cars glide back, the feed is the
  live feed's diff.

## Championship (#273)

- A solo season of the 4 races of `SEASON_CALENDAR` (`src/ui/season.ts`, pure, no engine): one human (car 1) against
  the same named bots with a pinned style (`SeasonDriver`), F1 points, a tie to the most wins, then count-back, then the
  last race. It lives in `localStorage["srp:season"]` (one at a time) and keeps each race's finishing order itself
  (`result.order`, the recap's places from `RaceSession.recapInfo().order` = `finishOrder`), so the table outlives the
  saved races (only the last 10 are kept); a result links to its recap while that saved race still exists.
  `loadSeason` drops a broken one, and one on a retired rules version with a notice on the home card.
- A season race is built from the season, never from the Quick race card: `getComposition()` in `main.ts` gives its
  track, laps, seed and bots, and `seasonCars()` pins names, styles (`RaceSeat.style`) and the grid on the session
  (`RaceSessionSetup.names/styles/grid`, through the `REG_SEASON_CARS` registry key). The cars and bot level are the
  Quick race card's when "Start championship" is pressed; the rules are the default. The grid of race 3 is the
  standings reversed (`seasonGrid`): `createRace(..., grid)` and `RaceLog.grid` take it, `replayRace` and the upload
  accept it (`createRace` refuses a grid that is not one slot per car, so a bad upload is a 400).
- No restart: Next race marks the race `started`; one that is not finished (back, the tab closed and reopened) is
  scored as a forfeit by `forfeitUnfinished` (the human last, the bots keep their order), at page load and when the
  race screen is left. Pages: the home card (`season_card.ts`), the results line, the standings (`season_page.ts`,
  route `/season`).
- The solo season is local; the lobby season is the server's (see the online-sessions skill) and the page only shows
  it: `/season` shows `lastLobby.season` while online (Back returns to the lobby), the results line is
  `seasonResultLine(season, lastRaceWithAResult, mySeatCarId)`, and the host's Play again reads "Next race" (the
  Next race button of the solo card is hidden online).
