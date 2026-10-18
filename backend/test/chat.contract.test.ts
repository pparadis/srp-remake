import assert from "node:assert/strict";
import test, { mock } from "node:test";
import type { BackendConfig } from "../src/config.js";
import { LobbyStore } from "../src/lobbyStore.js";
import { createApp } from "../src/server.js";
import type { ChatMessage } from "../src/types.js";
import { playRaceToEnd } from "./helpers.js";

const TEST_CONFIG: BackendConfig = {
  HOST: "127.0.0.1",
  PORT: 3001,
  CORS_ALLOWED_ORIGINS: "*",
  PLAYER_TOKEN_TTL_SECONDS: 86400
};

type App = Awaited<ReturnType<typeof createApp>>;
interface Seat {
  playerId: string;
  token: string;
}
interface Event {
  event: string;
  payload: { messages: ChatMessage[]; lobby?: object };
}

async function startApp(
  t: test.TestContext,
  config: Partial<BackendConfig> = {},
  lobbyStore?: LobbyStore
): Promise<App> {
  const app = await createApp({ ...TEST_CONFIG, ...config }, { logger: false, ...(lobbyStore ? { lobbyStore } : {}) });
  await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    mock.timers.reset();
    await app.close();
  });
  return app;
}

async function host(app: App, settings: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/lobbies",
    payload: { name: "Host", settings: { totalCars: 2, humanCars: 2, botCars: 0, ...settings } }
  });
  assert.equal(res.statusCode, 201);
  const body = res.json() as { lobby: { lobbyId: string }; playerId: string; playerToken: string };
  return { lobbyId: body.lobby.lobbyId, seat: { playerId: body.playerId, token: body.playerToken } as Seat };
}

async function guest(app: App, lobbyId: string, name = "Guest"): Promise<Seat> {
  const res = await app.inject({ method: "POST", url: `/api/v1/lobbies/${lobbyId}/join`, payload: { name } });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { playerId: string; playerToken: string };
  return { playerId: body.playerId, token: body.playerToken };
}

function say(app: App, lobbyId: string, token: string, text: string) {
  return app.inject({
    method: "POST",
    url: `/api/v1/lobbies/${lobbyId}/chat`,
    payload: { playerToken: token, text }
  });
}

// A socket that records what it receives; `ready` resolves once the connect burst has arrived.
async function connect(app: App, lobbyId: string, token: string) {
  const address = app.server.address() as { port: number };
  const ws = new WebSocket(`ws://127.0.0.1:${address.port}/ws?lobbyId=${lobbyId}&playerToken=${token}`);
  const events: Event[] = [];
  ws.addEventListener("message", (message) => events.push(JSON.parse(String(message.data)) as Event));
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("socket did not open")));
  });
  const waitFor = async (predicate: () => boolean) => {
    for (let i = 0; i < 200 && !predicate(); i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.ok(predicate(), "timed out waiting for a socket event");
  };
  await waitFor(() => events.some((e) => e.event === "chat.history"));
  return { ws, events, waitFor };
}

const last = <T>(items: T[]) => items[items.length - 1];

test("a message is 201 and reaches both players' sockets, with the author's name", async (t) => {
  const app = await startApp(t);
  const { lobbyId, seat: hostSeat } = await host(app);
  const guestSeat = await guest(app, lobbyId, "Zoe");
  const a = await connect(app, lobbyId, hostSeat.token);
  const b = await connect(app, lobbyId, guestSeat.token);

  const res = await say(app, lobbyId, guestSeat.token, "  gg 👍  ");
  assert.equal(res.statusCode, 201);
  const { message } = res.json() as { message: ChatMessage };
  assert.equal(message.text, "gg 👍");
  assert.equal(message.name, "Zoe");
  assert.equal(message.playerId, guestSeat.playerId);
  assert.equal(message.id, 1);

  for (const side of [a, b]) {
    await side.waitFor(() => side.events.some((e) => e.event === "chat.message"));
    assert.deepEqual(side.events.find((e) => e.event === "chat.message")?.payload, message);
  }
  a.ws.close();
  b.ws.close();
});

test("refuses empty and over-long text (400), a bad token (401) and an unknown lobby (404)", async (t) => {
  const app = await startApp(t);
  const { lobbyId, seat } = await host(app);

  assert.equal((await say(app, lobbyId, seat.token, " \n ")).statusCode, 400);
  assert.equal((await say(app, lobbyId, seat.token, "a".repeat(101))).statusCode, 400);
  assert.equal((await say(app, lobbyId, seat.token, "x".repeat(2001))).statusCode, 400);
  assert.equal((await say(app, lobbyId, "nope", "hi")).statusCode, 401);
  assert.equal((await say(app, "missing", seat.token, "hi")).statusCode, 404);
  // 100 graphemes is the limit, whatever the code units.
  assert.equal((await say(app, lobbyId, seat.token, "a".repeat(100))).statusCode, 201);
});

test("a player gets one message a second; another player is not held up", async (t) => {
  const app = await startApp(t);
  const { lobbyId, seat } = await host(app);
  const other = await guest(app, lobbyId);
  mock.timers.enable({ apis: ["Date"] });

  assert.equal((await say(app, lobbyId, seat.token, "one")).statusCode, 201);
  assert.equal((await say(app, lobbyId, seat.token, "two")).statusCode, 429);
  assert.equal((await say(app, lobbyId, other.token, "hello")).statusCode, 201);
  mock.timers.tick(1000);
  assert.equal((await say(app, lobbyId, seat.token, "two")).statusCode, 201);
});

test("a socket that connects later gets the last 50 messages, to itself only", async (t) => {
  const app = await startApp(t);
  const { lobbyId, seat } = await host(app);
  const other = await guest(app, lobbyId);
  const early = await connect(app, lobbyId, other.token);
  mock.timers.enable({ apis: ["Date"] });
  for (let i = 1; i <= 60; i += 1) {
    assert.equal((await say(app, lobbyId, seat.token, `msg ${i}`)).statusCode, 201);
    mock.timers.tick(1000);
  }
  const earlyHistories = early.events.filter((e) => e.event === "chat.history").length;

  const late = await connect(app, lobbyId, seat.token);
  const history = late.events.find((e) => e.event === "chat.history")!.payload.messages as ChatMessage[];
  assert.equal(history.length, 50);
  assert.equal(history[0]?.text, "msg 11");
  assert.equal(last(history)?.text, "msg 60");
  // The first socket was not sent the history again.
  assert.equal(early.events.filter((e) => e.event === "chat.history").length, earlyHistories);
  early.ws.close();
  late.ws.close();
});

test("the public lobby and race.state carry no chat", async (t) => {
  const app = await startApp(t);
  const { lobbyId, seat } = await host(app, { totalCars: 2, humanCars: 1, botCars: 1, raceLaps: 1, turnTimerSec: 0 });
  await say(app, lobbyId, seat.token, "hi");
  const conn = await connect(app, lobbyId, seat.token);
  await app.inject({ method: "POST", url: `/api/v1/lobbies/${lobbyId}/start`, payload: { playerToken: seat.token } });
  await conn.waitFor(() => conn.events.some((e) => e.event === "race.state"));

  for (const e of conn.events.filter((x) => x.event !== "chat.history" && x.event !== "chat.message")) {
    const lobby = e.payload.lobby ?? e.payload;
    assert.equal("chat" in lobby, false, `${e.event} carries chat`);
  }
  const read = await app.inject({ method: "GET", url: `/api/v1/lobbies/${lobbyId}?playerToken=${seat.token}` });
  assert.equal("chat" in (read.json() as { lobby: object }).lobby, false);
  conn.ws.close();
});

test("chat works in the race and on the results screen, and survives play again", async (t) => {
  const app = await startApp(t);
  const { lobbyId, seat } = await host(app, { totalCars: 2, humanCars: 1, botCars: 1, raceLaps: 1, turnTimerSec: 0 });
  mock.timers.enable({ apis: ["Date"] });
  await app.inject({ method: "POST", url: `/api/v1/lobbies/${lobbyId}/start`, payload: { playerToken: seat.token } });
  assert.equal((await say(app, lobbyId, seat.token, "in race")).statusCode, 201);

  const finished = await playRaceToEnd(app, lobbyId, seat.token);
  assert.equal(finished.status, "FINISHED");
  mock.timers.tick(1000);
  assert.equal((await say(app, lobbyId, seat.token, "gg")).statusCode, 201);

  const reset = await app.inject({ method: "POST", url: `/api/v1/lobbies/${lobbyId}/reset`, payload: { playerToken: seat.token } });
  assert.equal(reset.statusCode, 200);
  const conn = await connect(app, lobbyId, seat.token);
  const history = conn.events.find((e) => e.event === "chat.history")!.payload.messages as ChatMessage[];
  assert.deepEqual(history.map((m) => m.text), ["in race", "gg"]);
  conn.ws.close();
});

test("a terminated lobby refuses chat: its tokens are revoked", async (t) => {
  const store = new LobbyStore(86400 * 1000);
  const app = await startApp(t, {}, store);
  const { lobbyId, seat } = await host(app);
  assert.equal((await say(app, lobbyId, seat.token, "before")).statusCode, 201);
  store.terminateLobby(lobbyId, "host_disconnected");
  assert.equal((await say(app, lobbyId, seat.token, "after")).statusCode, 401);
});

test("rate limit: the 61st chat request a minute from one IP is 429", async (t) => {
  const app = await startApp(t, { RATE_LIMIT_ENABLED: true });
  const { lobbyId } = await host(app);
  // A bad token answers 401 without touching the per-player pause, so only the IP limit can stop these.
  for (let i = 0; i < 60; i += 1) {
    assert.equal((await say(app, lobbyId, "nope", "hi")).statusCode, 401, `request ${i + 1}`);
  }
  const res = await say(app, lobbyId, "nope", "hi");
  assert.equal(res.statusCode, 429);
  assert.ok(Number(res.headers["retry-after"]) > 0);
});
