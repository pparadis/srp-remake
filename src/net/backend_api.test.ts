import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendApiClient, BackendApiError, resolveBackendWsBaseUrl } from './backend_api';

function stubFetch(status: number, body: string) {
  const fetchMock = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function lastCall(fetchMock: ReturnType<typeof stubFetch>) {
  const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [
    string,
    { method: string; body?: string }
  ];
  return { url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : undefined };
}

describe('BackendApiClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends each call to its v1 route with a JSON body', async () => {
    const fetchMock = stubFetch(200, JSON.stringify({ ok: true }));
    const client = new BackendApiClient('http://api.test//');
    const settings = {
      trackId: 't',
      totalCars: 2,
      humanCars: 1,
      botCars: 1,
      raceLaps: 3,
      turnTimerSec: 60 as const,
      botLevel: 'normal' as const
    };

    await expect(client.createLobby('Host', settings)).resolves.toEqual({ ok: true });
    expect(lastCall(fetchMock)).toEqual({
      url: 'http://api.test/api/v1/lobbies',
      method: 'POST',
      body: { name: 'Host', settings }
    });

    await client.joinLobby('a b', 'Guest');
    expect(lastCall(fetchMock)).toMatchObject({
      url: 'http://api.test/api/v1/lobbies/a%20b/join',
      body: { name: 'Guest' }
    });

    await client.joinLobby('L1', 'Guest', 'tok');
    expect(lastCall(fetchMock).body).toEqual({ name: 'Guest', playerToken: 'tok' });

    await client.startRace('L1', 'tok');
    expect(lastCall(fetchMock)).toMatchObject({
      url: 'http://api.test/api/v1/lobbies/L1/start',
      body: { playerToken: 'tok' }
    });

    await client.resetLobby('L1', 'tok');
    expect(lastCall(fetchMock)).toMatchObject({
      url: 'http://api.test/api/v1/lobbies/L1/reset',
      method: 'POST',
      body: { playerToken: 'tok' }
    });

    await client.updateSettings('L1', 'tok', { raceLaps: 2 });
    expect(lastCall(fetchMock)).toMatchObject({
      url: 'http://api.test/api/v1/lobbies/L1/settings',
      method: 'PATCH',
      body: { playerToken: 'tok', settings: { raceLaps: 2 } }
    });

    await client.readLobby('L1', 't&k');
    expect(lastCall(fetchMock)).toEqual({
      url: 'http://api.test/api/v1/lobbies/L1?playerToken=t%26k',
      method: 'GET',
      body: undefined
    });

    await client.submitTurn('L1', 'tok', 4, 'cmd-1', { type: 'skip' });
    expect(lastCall(fetchMock)).toMatchObject({
      url: 'http://api.test/api/v1/lobbies/L1/turns',
      body: { playerToken: 'tok', revision: 4, clientCommandId: 'cmd-1', action: { type: 'skip' } }
    });
  });

  it('returns an empty object for an empty body and wraps non-JSON text', async () => {
    stubFetch(200, '');
    await expect(new BackendApiClient('http://api.test').startRace('L1', 'tok')).resolves.toEqual(
      {}
    );

    stubFetch(200, 'not json');
    await expect(new BackendApiClient('http://api.test').startRace('L1', 'tok')).resolves.toEqual({
      raw: 'not json'
    });
  });

  it('throws BackendApiError with status and payload on non-2xx', async () => {
    stubFetch(409, JSON.stringify({ error: 'stale_revision' }));
    const error = await new BackendApiClient('http://api.test')
      .startRace('L1', 'tok')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BackendApiError);
    expect(error).toMatchObject({ status: 409, payload: { error: 'stale_revision' } });
  });
});

describe('submitTurn rejections', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const rejection = {
    ok: false,
    lobbyId: 'L1',
    playerId: 'p1',
    clientCommandId: 'c1',
    revision: 3,
    error: 'invalid_action',
    reason: 'invalid_target'
  };

  it('returns a refused turn (409 with a result body) instead of throwing', async () => {
    stubFetch(409, JSON.stringify(rejection));

    const result = await new BackendApiClient('http://api.test').submitTurn('L1', 'tok', 3, 'c1', {
      type: 'skip'
    });

    expect(result).toEqual(rejection);
  });

  it('still throws for other failures', async () => {
    stubFetch(409, JSON.stringify({ error: 'Race already started or finished.' }));
    await expect(
      new BackendApiClient('http://api.test').submitTurn('L1', 'tok', 3, 'c1', { type: 'skip' })
    ).rejects.toBeInstanceOf(BackendApiError);

    stubFetch(400, JSON.stringify({ ...rejection }));
    await expect(
      new BackendApiClient('http://api.test').submitTurn('L1', 'tok', 3, 'c1', { type: 'skip' })
    ).rejects.toMatchObject({
      status: 400
    });
  });
});

describe('resolveBackendWsBaseUrl', () => {
  it('derives ws/wss from the API base URL', () => {
    expect(resolveBackendWsBaseUrl('http://localhost:3001')).toBe('ws://localhost:3001');
    expect(resolveBackendWsBaseUrl('https://api.example.com/')).toBe('wss://api.example.com');
  });
});

describe('BackendApiClient timeouts and new routes', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('aborts a request that outlasts the timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError'))
            );
          })
      )
    );
    const client = new BackendApiClient('http://api.test', 1000);
    const pending = client.health();
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
  });

  it('calls force-skip with the revision and the health route', async () => {
    const fetchMock = stubFetch(200, '{}');
    const client = new BackendApiClient('http://api.test');
    await client.forceSkip('L1', 'tok', 7);
    expect(lastCall(fetchMock)).toEqual({
      url: 'http://api.test/api/v1/lobbies/L1/force-skip',
      method: 'POST',
      body: { playerToken: 'tok', revision: 7 }
    });
    await client.health();
    expect(lastCall(fetchMock)).toMatchObject({ url: 'http://api.test/health', method: 'GET' });
  });
});

describe('uploadRace device token (#194)', () => {
  const log = { seats: [], raceLaps: 1, seed: 0, rulesVersion: 'v3', actions: [] } as never;
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  // `races` answers each upload in turn; every call is recorded as "METHOD path auth".
  function stubServer(races: Response[]) {
    const calls: string[] = [];
    let minted = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { method: string; headers?: Record<string, string> }) => {
        const path = new URL(url).pathname;
        calls.push(`${init.method} ${path} ${init.headers?.Authorization ?? ''}`.trim());
        if (path === '/api/v1/devices') {
          minted += 1;
          return json({ deviceToken: `token-${minted}` }, 201);
        }
        return races.shift() ?? json({ error: 'no more answers' }, 500);
      })
    );
    return calls;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  it('mints a token on the first upload, keeps it, and sends it as a bearer token', async () => {
    const calls = stubServer([
      json({ id: 'a', duplicate: false }, 201),
      json({ id: 'b', duplicate: false }, 201)
    ]);
    const client = new BackendApiClient('http://api.test');
    await client.uploadRace('t', log);
    await client.uploadRace('t', log);
    expect(calls).toEqual([
      'POST /api/v1/devices',
      'POST /api/v1/races Bearer token-1',
      'POST /api/v1/races Bearer token-1'
    ]);
    expect(window.localStorage.getItem('srp:device')).toBe('token-1');
  });

  it('uses the token already in storage', async () => {
    window.localStorage.setItem('srp:device', 'kept');
    const calls = stubServer([json({ id: 'a', duplicate: false }, 201)]);
    await new BackendApiClient('http://api.test').uploadRace('t', log);
    expect(calls).toEqual(['POST /api/v1/races Bearer kept']);
  });

  it('replaces a token the server does not know and tries once more, but only once', async () => {
    window.localStorage.setItem('srp:device', 'stale');
    const calls = stubServer([
      json({ error: 'A device token is required.' }, 401),
      json({ id: 'a', duplicate: false }, 201)
    ]);
    const client = new BackendApiClient('http://api.test');
    await client.uploadRace('t', log);
    expect(calls).toEqual([
      'POST /api/v1/races Bearer stale',
      'POST /api/v1/devices',
      'POST /api/v1/races Bearer token-1'
    ]);
    expect(window.localStorage.getItem('srp:device')).toBe('token-1');

    const again = stubServer([json({ error: 'no' }, 401), json({ error: 'no' }, 401)]);
    await expect(client.uploadRace('t', log)).rejects.toMatchObject({ status: 401 });
    expect(again.filter((call) => call.includes('/races'))).toHaveLength(2);
  });

  it('does not retry other failures', async () => {
    window.localStorage.setItem('srp:device', 'kept');
    const calls = stubServer([json({ error: 'down' }, 503)]);
    await expect(
      new BackendApiClient('http://api.test').uploadRace('t', log)
    ).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);
  });
});
