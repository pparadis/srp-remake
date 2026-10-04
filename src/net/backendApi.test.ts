import { afterEach, describe, expect, it, vi } from "vitest";
import { BackendApiClient, BackendApiError, resolveBackendWsBaseUrl } from "./backendApi";

function stubFetch(status: number, body: string) {
  const fetchMock = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function lastCall(fetchMock: ReturnType<typeof stubFetch>) {
  const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, { method: string; body?: string }];
  return { url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined };
}

describe("BackendApiClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends each call to its v1 route with a JSON body", async () => {
    const fetchMock = stubFetch(200, JSON.stringify({ ok: true }));
    const client = new BackendApiClient("http://api.test//");
    const settings = { trackId: "t", totalCars: 2, humanCars: 1, botCars: 1, raceLaps: 3 };

    await expect(client.createLobby("Host", settings)).resolves.toEqual({ ok: true });
    expect(lastCall(fetchMock)).toEqual({
      url: "http://api.test/api/v1/lobbies",
      method: "POST",
      body: { name: "Host", settings }
    });

    await client.joinLobby("a b", "Guest");
    expect(lastCall(fetchMock)).toMatchObject({ url: "http://api.test/api/v1/lobbies/a%20b/join", body: { name: "Guest" } });

    await client.joinLobby("L1", "Guest", "tok");
    expect(lastCall(fetchMock).body).toEqual({ name: "Guest", playerToken: "tok" });

    await client.startRace("L1", "tok");
    expect(lastCall(fetchMock)).toMatchObject({ url: "http://api.test/api/v1/lobbies/L1/start", body: { playerToken: "tok" } });

    await client.readLobby("L1", "t&k");
    expect(lastCall(fetchMock)).toEqual({
      url: "http://api.test/api/v1/lobbies/L1?playerToken=t%26k",
      method: "GET",
      body: undefined
    });

    await client.submitTurn("L1", "tok", 4, "cmd-1", { type: "skip" });
    expect(lastCall(fetchMock)).toMatchObject({
      url: "http://api.test/api/v1/lobbies/L1/turns",
      body: { playerToken: "tok", revision: 4, clientCommandId: "cmd-1", action: { type: "skip" } }
    });
  });

  it("returns an empty object for an empty body and wraps non-JSON text", async () => {
    stubFetch(200, "");
    await expect(new BackendApiClient("http://api.test").startRace("L1", "tok")).resolves.toEqual({});

    stubFetch(200, "not json");
    await expect(new BackendApiClient("http://api.test").startRace("L1", "tok")).resolves.toEqual({ raw: "not json" });
  });

  it("throws BackendApiError with status and payload on non-2xx", async () => {
    stubFetch(409, JSON.stringify({ error: "stale_revision" }));
    const error = await new BackendApiClient("http://api.test").startRace("L1", "tok").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackendApiError);
    expect(error).toMatchObject({ status: 409, payload: { error: "stale_revision" } });
  });
});

describe("resolveBackendWsBaseUrl", () => {
  it("derives ws/wss from the API base URL", () => {
    expect(resolveBackendWsBaseUrl("http://localhost:3001")).toBe("ws://localhost:3001");
    expect(resolveBackendWsBaseUrl("https://api.example.com/")).toBe("wss://api.example.com");
  });
});
