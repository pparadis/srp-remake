import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import Fastify from 'fastify';
import { LobbyStore } from '../src/lobby_store.js';
import { MemoryRaceStore } from '../src/race_store.js';
import { createRealtime, type LobbySocket } from '../src/realtime.js';
import type { TurnSubmitAction } from '../src/types.js';

// No HTTP here: a store, the realtime parts and fake clocks (#212).
const CONFIG = { TURN_TIMER_TIME_SCALE: 1, HOST_GRACE_SECONDS: 5, LOBBY_IDLE_SECONDS: 10 };

function fakeSocket() {
  const sent: { event: string; payload: { source?: string } }[] = [];
  const closed: (number | undefined)[] = [];
  const socket: LobbySocket = {
    readyState: 1,
    send: (data) => void sent.push(JSON.parse(data)),
    close: (code) => void closed.push(code),
    ping: () => undefined,
    terminate: () => undefined,
    on: () => undefined
  };
  return { socket, sent, closed };
}

function setup(t: test.TestContext, onReap?: (lobbyId: string) => void) {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  t.after(() => mock.timers.reset());
  const lobbyStore = new LobbyStore();
  const raceStore = new MemoryRaceStore();
  const realtime = createRealtime({
    lobbyStore,
    raceStore,
    config: CONFIG,
    log: Fastify({ logger: false }).log,
    ...(onReap ? { onReap } : {})
  });
  t.after(() => realtime.stop());
  return { lobbyStore, realtime, raceStore };
}

// A started race: the host (a human seat) and one bot, with a 30 s turn timer. The human is up first.
async function startedRace(t: test.TestContext) {
  const ctx = setup(t);
  const { lobby, host } = ctx.lobbyStore.createLobby('Host', {
    totalCars: 2,
    humanCars: 1,
    botCars: 1,
    raceLaps: 3,
    turnTimerSec: 30
  });
  ctx.lobbyStore.startRace(lobby.lobbyId, host.playerToken);
  ctx.realtime.armTurnTimer(lobby.lobbyId);
  await ctx.realtime.runPendingBotTurns(lobby.lobbyId);
  assert.equal(ctx.lobbyStore.getActiveRaceSeat(lobby.lobbyId)?.isBot, false);
  const watcher = fakeSocket();
  ctx.realtime.addSocket(lobby.lobbyId, 'watcher', watcher.socket);
  return { ...ctx, lobbyId: lobby.lobbyId, host, watcher };
}

const timeouts = (sent: { payload: { source?: string } }[]) =>
  sent.filter((m) => m.payload.source === 'timeout').length;

test('the turn timer plays the autopilot once when it expires, not again until the next expiry', async (t) => {
  const { realtime, lobbyId, watcher } = await startedRace(t);
  realtime.armTurnTimer(lobbyId);

  mock.timers.tick(29_999);
  assert.equal(timeouts(watcher.sent), 0);
  mock.timers.tick(1);
  assert.equal(timeouts(watcher.sent), 1);

  // The bot answered and the human is up again with a fresh timer: nothing more happens before it expires.
  mock.timers.tick(29_999);
  assert.equal(timeouts(watcher.sent), 1);
  mock.timers.tick(1);
  assert.equal(timeouts(watcher.sent), 2);
});

test('a grid setup does not re-arm the turn timer, a played turn does', async (t) => {
  const { realtime, lobbyStore, lobbyId, host } = await startedRace(t);
  realtime.armTurnTimer(lobbyId);
  const deadline = () => lobbyStore.getLobby(lobbyId)?.race?.turnDeadlineAt;
  const armedAt = deadline();
  assert.ok(armedAt !== undefined);

  mock.timers.tick(10_000);
  const lobby = lobbyStore.incrementRevision(lobbyId);
  const setup: TurnSubmitAction = {
    type: 'setup',
    setup: { compound: 'medium', psi: { fl: 20, fr: 20, rl: 20, rr: 20 }, wing: 'medium' }
  };
  const event = (applied: TurnSubmitAction) => ({
    ok: true as const,
    lobbyId,
    playerId: host.playerId,
    clientCommandId: 'c',
    revision: lobby.revision,
    applied
  });

  realtime.announceTurn(lobby, event(setup));
  assert.equal(deadline(), armedAt);

  realtime.announceTurn(lobby, event({ type: 'skip' }));
  assert.equal(deadline(), armedAt + 10_000);
});

test('the host grace period ends the lobby and closes its sockets, unless the host comes back', async (t) => {
  const { realtime, lobbyStore } = setup(t);
  const { lobby, host } = lobbyStore.createLobby('Host');
  const watcher = fakeSocket();
  realtime.addSocket(lobby.lobbyId, host.playerId, watcher.socket);

  realtime.startHostGrace(lobby.lobbyId);
  mock.timers.tick(4_999);
  assert.equal(lobbyStore.getLobby(lobby.lobbyId)?.status, 'WAITING');
  realtime.cancelHostGrace(lobby.lobbyId);
  mock.timers.tick(10_000);
  assert.equal(lobbyStore.getLobby(lobby.lobbyId)?.status, 'WAITING');

  realtime.startHostGrace(lobby.lobbyId);
  mock.timers.tick(5_000);
  const ended = lobbyStore.getLobby(lobby.lobbyId);
  assert.equal(ended?.status, 'FINISHED');
  assert.equal(ended?.terminationReason, 'host_disconnected');
  assert.deepEqual(
    watcher.sent.map((m) => m.event),
    ['race.ended']
  );
  assert.deepEqual(watcher.closed, [4001]);
});

test('the reaper takes an idle lobby nobody is connected to, and skips one with an open socket', (t) => {
  const reaped: string[] = [];
  const { realtime, lobbyStore } = setup(t, (lobbyId) => reaped.push(lobbyId));
  const abandoned = lobbyStore.createLobby('Gone').lobby.lobbyId;
  const watched = lobbyStore.createLobby('Here');
  realtime.addSocket(watched.lobby.lobbyId, watched.host.playerId, fakeSocket().socket);

  mock.timers.tick(10_000);
  realtime.reapDeadLobbies();
  assert.equal(lobbyStore.count(), 2);

  mock.timers.tick(1);
  realtime.reapDeadLobbies();
  assert.equal(lobbyStore.getLobby(abandoned), undefined);
  assert.ok(lobbyStore.getLobby(watched.lobby.lobbyId));
  assert.deepEqual(reaped, [abandoned]);
});

test('an online race whose log is over the action cap is not stored (#211)', async (t) => {
  const { lobbyStore, realtime, raceStore } = setup(t);
  const { lobby, host } = lobbyStore.createLobby('Host', {
    totalCars: 2,
    humanCars: 1,
    botCars: 1,
    raceLaps: 1
  });
  lobbyStore.startRace(lobby.lobbyId, host.playerToken);
  const race = lobby.race;
  assert.ok(race);
  race.engine.winnerCarId = 1;
  race.log.actions.push(...Array.from({ length: 2001 }, () => ({ type: 'skip' as const })));
  realtime.announceTurn(lobby, { applied: { type: 'skip' } } as never);
  await Promise.resolve();
  assert.equal((await raceStore.list(10)).length, 0);

  race.stored = false;
  race.log.actions.length = 2000;
  realtime.announceTurn(lobby, { applied: { type: 'skip' } } as never);
  for (let i = 0; i < 20 && (await raceStore.list(10)).length === 0; i += 1) {
    await Promise.resolve();
  }
  assert.equal((await raceStore.list(10)).length, 1);
});
