import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { BackendConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import type { PublicLobby } from "../src/types.js";
import { legalMove, playRaceToEnd, readLobby } from "./helpers.js";

const TEST_CONFIG: BackendConfig = {
  HOST: "127.0.0.1",
  PORT: 3001,
  CORS_ALLOWED_ORIGINS: "*",
  PLAYER_TOKEN_TTL_SECONDS: 86400,
  HOST_GRACE_SECONDS: 45,
  TURN_TIMER_TIME_SCALE: 1
};

type App = Awaited<ReturnType<typeof createApp>>;
type WsEvent = { event: string; payload: any };

async function setup(
  t: { after: (fn: () => Promise<void>) => void },
  config: Partial<BackendConfig>,
  settings: Record<string, number>,
  { start = true, guest = true } = {}
) {
  const app = await createApp({ ...TEST_CONFIG, ...config }, { logger: false });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close();
  });
  const created = await app.inject({ method: "POST", url: "/api/v1/lobbies", payload: { name: "Host", settings } });
  const host = created.json() as { lobby: PublicLobby; playerToken: string };
  const lobbyId = host.lobby.lobbyId;
  let guestToken = "";
  if (guest && settings.humanCars === 2) {
    const joined = await app.inject({ method: "POST", url: `/api/v1/lobbies/${lobbyId}/join`, payload: { name: "Guest" } });
    guestToken = (joined.json() as { playerToken: string }).playerToken;
  }
  if (start) {
    const started = await app.inject({ method: "POST", url: `/api/v1/lobbies/${lobbyId}/start`, payload: { playerToken: host.playerToken } });
    assert.equal(started.statusCode, 200);
  }
  return { app, lobbyId, hostToken: host.playerToken, guestToken };
}

function connect(app: App, lobbyId: string, token: string) {
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("not listening");
  const events: WsEvent[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws?lobbyId=${lobbyId}&playerToken=${encodeURIComponent(token)}`);
  ws.addEventListener("message", (raw) => events.push(JSON.parse(String(raw.data)) as WsEvent));
  const open = new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("ws error")));
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason }))
  );
  return { ws, events, open, closed };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await delay(15);
  }
  throw new Error("Timed out waiting for condition.");
}

const post = (app: App, lobbyId: string, path: string, payload: unknown) =>
  app.inject({ method: "POST", url: `/api/v1/lobbies/${lobbyId}/${path}`, payload: payload as object });

const HUMANS = { totalCars: 2, humanCars: 2, botCars: 0, raceLaps: 3 };

test("turn timer: an AFK seat is auto-played with source timeout and the timer re-arms", async (t) => {
  // 30 s * 0.02 = 0.6 s
  const { app, lobbyId, hostToken } = await setup(t, { TURN_TIMER_TIME_SCALE: 0.02 }, { ...HUMANS, turnTimerSec: 30 });
  const host = connect(app, lobbyId, hostToken);
  await host.open;

  const first = await readLobby(app, lobbyId, hostToken);
  const remaining = first.raceState.turnRemainingMs;
  assert.ok(remaining !== undefined && remaining > 0 && remaining <= 600, `turnRemainingMs=${remaining}`);

  const timeouts = () => host.events.filter((e) => e.event === "turn.applied" && e.payload.source === "timeout");
  await waitFor(() => timeouts().length >= 2);
  // seat 0 (host) first, then seat 1: the timer was re-armed for the next human
  assert.deepEqual(timeouts().slice(0, 2).map((e) => e.payload.seatIndex), [0, 1]);
  assert.equal(timeouts()[0]!.payload.applied.type, "move");
  const state = host.events.filter((e) => e.event === "race.state").at(-1)!.payload;
  assert.ok(state.raceState.turnRemainingMs > 0, "race.state carries the new deadline");
  host.ws.close();
});

test("turn timer: Off never auto-plays and exposes no countdown; invalid choices are rejected", async (t) => {
  const { app, lobbyId, hostToken } = await setup(t, { TURN_TIMER_TIME_SCALE: 0.01 }, { ...HUMANS, turnTimerSec: 0 });
  const before = await readLobby(app, lobbyId, hostToken);
  assert.equal(before.raceState.turnRemainingMs, undefined);
  await delay(300);
  assert.equal((await readLobby(app, lobbyId, hostToken)).revision, before.revision);

  const created = await app.inject({ method: "POST", url: "/api/v1/lobbies", payload: { name: "H", settings: { turnTimerSec: 45 } } });
  assert.equal(created.statusCode, 400);
  const def = await app.inject({ method: "POST", url: "/api/v1/lobbies", payload: { name: "H" } });
  assert.equal((def.json() as { lobby: PublicLobby }).lobby.settings.turnTimerSec, 60);
});

test("turn timer: a human move re-arms it and the stale timer does not play the next seat early", async (t) => {
  // 1.5 s timer; the host moves at ~0.9 s, so the guest must still get a full turn.
  const { app, lobbyId, hostToken, guestToken } = await setup(t, { TURN_TIMER_TIME_SCALE: 0.05 }, { ...HUMANS, turnTimerSec: 30 });
  const host = connect(app, lobbyId, hostToken);
  await host.open;
  await delay(900);
  const lobby = await readLobby(app, lobbyId, hostToken);
  const res = await post(app, lobbyId, "turns", {
    playerToken: hostToken,
    clientCommandId: "m1",
    revision: lobby.revision,
    action: legalMove(lobby.raceState)
  });
  assert.equal(res.statusCode, 200);
  await delay(900); // past the first deadline, before the guest's own
  assert.equal(host.events.filter((e) => e.payload?.source === "timeout").length, 0);
  assert.ok(guestToken);
  await waitFor(() => host.events.some((e) => e.payload?.source === "timeout" && e.payload.seatIndex === 1));
  host.ws.close();
});

test("force-skip: 401 bad token, 403 non-host, 409 not in race / bot active / stale revision, 200 plays an autopilot turn", async (t) => {
  const { app, lobbyId, hostToken, guestToken } = await setup(t, {}, { ...HUMANS, turnTimerSec: 0 }, { start: false });
  assert.equal((await post(app, lobbyId, "force-skip", { playerToken: hostToken })).statusCode, 409, "waiting lobby");
  await post(app, lobbyId, "start", { playerToken: hostToken });

  assert.equal((await post(app, lobbyId, "force-skip", { playerToken: "nope" })).statusCode, 401);
  assert.equal((await post(app, lobbyId, "force-skip", { playerToken: guestToken })).statusCode, 403);
  assert.equal((await post(app, "missing", "force-skip", { playerToken: hostToken })).statusCode, 404);
  const lobby = await readLobby(app, lobbyId, hostToken);
  assert.equal((await post(app, lobbyId, "force-skip", { playerToken: hostToken, revision: lobby.revision + 5 })).statusCode, 409);

  const host = connect(app, lobbyId, hostToken);
  await host.open;
  const ok = await post(app, lobbyId, "force-skip", { playerToken: hostToken, revision: lobby.revision });
  assert.equal(ok.statusCode, 200);
  await waitFor(() => host.events.some((e) => e.event === "turn.applied" && e.payload.source === "force_skip"));
  const after = await readLobby(app, lobbyId, hostToken);
  assert.equal(after.revision, lobby.revision + 1);
  assert.equal(after.raceState.activeSeatIndex, 1);
  host.ws.close();
});

test("force-skip: 409 while a bot seat is active or after the race ended", async (t) => {
  const { app, lobbyId, hostToken } = await setup(t, {}, { totalCars: 2, humanCars: 1, botCars: 1, raceLaps: 1, turnTimerSec: 0 });
  await playRaceToEnd(app, lobbyId, hostToken);
  assert.equal((await post(app, lobbyId, "force-skip", { playerToken: hostToken })).statusCode, 409);
});

test("host grace: a host reconnect within the grace period keeps the lobby", async (t) => {
  const { app, lobbyId, hostToken, guestToken } = await setup(t, { HOST_GRACE_SECONDS: 0.6 }, { ...HUMANS, turnTimerSec: 0 });
  const guest = connect(app, lobbyId, guestToken);
  const host = connect(app, lobbyId, hostToken);
  await Promise.all([guest.open, host.open]);

  host.ws.close();
  await host.closed;
  await waitFor(() =>
    guest.events.some(
      (e) => e.event === "lobby.state" && e.payload.players.find((p: { isHost: boolean }) => p.isHost).connected === false
    )
  );
  const back = connect(app, lobbyId, hostToken);
  await back.open;
  await delay(900); // well past the grace period
  assert.equal((await readLobby(app, lobbyId, hostToken)).status, "IN_RACE");
  assert.equal(guest.events.some((e) => e.event === "race.ended"), false);
  const last = guest.events.filter((e) => e.event === "lobby.state").at(-1)!.payload as PublicLobby;
  assert.equal(last.players.find((p) => p.isHost)!.connected, true);

  // and the grace period starts over on the next disconnect, then ends the lobby
  back.ws.close();
  const closed = await guest.closed;
  assert.equal(closed.code, 4001);
  assert.equal((await app.inject({ method: "GET", url: `/api/v1/lobbies/${lobbyId}?playerToken=${hostToken}` })).statusCode, 401);
});

test("per-player sockets: an old socket closing after a reconnect does not mark the player disconnected", async (t) => {
  const { app, lobbyId, hostToken, guestToken } = await setup(t, { HOST_GRACE_SECONDS: 0.3 }, { ...HUMANS, turnTimerSec: 0 });
  const host = connect(app, lobbyId, hostToken);
  const oldGuest = connect(app, lobbyId, guestToken);
  await Promise.all([host.open, oldGuest.open]);
  const newGuest = connect(app, lobbyId, guestToken);
  await newGuest.open;

  oldGuest.ws.close();
  await oldGuest.closed;
  await delay(150);
  const players = (await readLobby(app, lobbyId, hostToken)) as unknown as PublicLobby;
  assert.equal(players.players.find((p) => !p.isHost)!.connected, true);

  newGuest.ws.close();
  await newGuest.closed;
  await waitFor(() => host.events.some((e) => e.event === "lobby.state" && e.payload.players.some((p: { isHost: boolean; connected: boolean }) => !p.isHost && !p.connected)));
  host.ws.close();
});

test("timers are cleared when the race finishes and when the lobby is reset", async (t) => {
  const { app, lobbyId, hostToken } = await setup(t, { TURN_TIMER_TIME_SCALE: 0.05 }, { totalCars: 2, humanCars: 1, botCars: 1, raceLaps: 1, turnTimerSec: 30 });
  const lobby = await playRaceToEnd(app, lobbyId, hostToken);
  assert.equal(lobby.status, "FINISHED");
  assert.equal(lobby.raceState.turnRemainingMs, undefined, "no countdown after the finish");

  const reset = await post(app, lobbyId, "reset", { playerToken: hostToken });
  assert.equal(reset.statusCode, 200);
  const waiting = await readLobby(app, lobbyId, hostToken);
  await delay(1800); // longer than the 1.5 s timer would have taken
  const later = await readLobby(app, lobbyId, hostToken);
  assert.equal(later.status, "WAITING");
  assert.equal(later.revision, waiting.revision);

  // a second race gets a fresh timer
  await post(app, lobbyId, "start", { playerToken: hostToken });
  const second = await readLobby(app, lobbyId, hostToken);
  assert.ok(second.raceState.turnRemainingMs! > 1000);
});
