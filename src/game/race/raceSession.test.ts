import { afterEach, describe, expect, it, vi } from "vitest";
import track from "../../../public/tracks/oval16_3lanes.json";
import type { TrackData } from "../types/track";
import type { PublicLobby } from "../../net/backendApi";
import { stintEstimate } from "../systems/strategy";
import { applyAction, computeTargets, createRace, getActiveCar, type RaceAction, type RaceSeat, type RaceState } from "./raceEngine";
import { RaceSession, SERVER_WAIT_MS, type HudView, type RaceSessionSetup } from "./raceSession";

const TRACK = track as unknown as TrackData;
const AT = { x: 120, y: 340 };

function solo(over: Partial<RaceSessionSetup> = {}): RaceSession {
  const botCars = over.botCars ?? 2;
  return new RaceSession(TRACK, { totalCars: 1 + botCars, humanCars: 1, botCars, raceLaps: 2, seed: 0, ...over });
}

function view(over: Partial<HudView> = {}): HudView {
  return { hoverCell: null, showCarsAndMoves: true, showForwardIndex: false, cellScreenPos: () => AT, ...over };
}

const hud = (session: RaceSession, over: Partial<HudView> = {}) => session.hudSnapshot(view(over))!;

// What a player would drag: the furthest target that is not a pit stop (the e2e helper's choice).
function furthestMove(session: RaceSession): RaceAction {
  const best = [...session.validTargets].filter(([, t]) => !t.isPitTrigger).sort((a, b) => b[1].distance - a[1].distance)[0];
  return best ? { type: "move", targetCellId: best[0] } : { type: "skip" };
}

// The scene's turn: the player's action, then the bots until the player is on turn again, then the new targets.
function playMyTurn(session: RaceSession) {
  session.recomputeTargets();
  expect(session.applyLocal(furthestMove(session))).toBe(true);
  session.runBots();
  session.recomputeTargets();
}

describe("RaceSession: solo", () => {
  it("starts with the human on pole and the bots behind, on turn when the race opens", () => {
    const session = solo({ botCars: 3 });
    expect(session.cars.map((c) => c.isBot)).toEqual([false, true, true, true]);
    expect(session.cars.map((c) => c.lapCount)).toEqual([0, 0, 0, -1]); // the last row starts behind the line
    expect(session.localCar()?.carId).toBe(1);
    expect(session.activeCar.carId).toBe(1);
    expect(session.localCanControl()).toBe(true);
    const snap = hud(session);
    expect(snap).toMatchObject({ raceLaps: 2, myCarId: 1, activeCarId: 1, canControl: true, finished: false, winnerCarId: null });
    expect(snap.cars.map((c) => c.lap)).toEqual([1, 1, 1, 0]);
    expect(snap.cars.find((c) => c.carId === 1)?.name).toBe("You");
    expect(snap.cars.find((c) => c.carId === 2)?.name).toBe("Car 2");
  });

  it("the HUD numbers follow the state after a move: lap, tire, fuel, move cycle and standings", () => {
    const session = solo();
    session.recomputeTargets();
    const before = hud(session).cars.find((c) => c.carId === 1)!;
    expect(before).toMatchObject({ tire: 100, fuel: 100, cycleIndex: 0, cycle: [0, 0, 0, 0, 0] });

    playMyTurn(session);
    const car = session.cars.find((c) => c.carId === 1)!;
    const snap = hud(session);
    const mine = snap.cars.find((c) => c.carId === 1)!;
    expect(mine.tire).toBe(car.tire);
    expect(mine.tire).toBeLessThan(100);
    expect(mine.fuel).toBe(car.fuel);
    expect(mine.fuel).toBeLessThan(100);
    expect(mine.cycleIndex).toBe(1);
    expect(mine.cycle[0]).toBeGreaterThan(0);
    expect(mine.remaining).toBe(40 - mine.cycle[0]!);
    expect(mine.lap).toBe((car.lapCount ?? 0) + 1);
    // the bots played too, and the standings are in race order
    expect(session.activeCar.carId).toBe(1);
    expect(snap.cars).toHaveLength(3);
    const progress = snap.cars.map((c) => c.progress);
    expect([...progress].sort((a, b) => b - a)).toEqual(progress);
    expect(snap.log.some((line) => /Car 2/.test(line))).toBe(true);
  });

  it("logs and keeps the state when the engine rejects an action", () => {
    const session = solo();
    const cells = session.cars.map((c) => c.cellId);
    expect(session.applyLocal({ type: "move", targetCellId: "nowhere" })).toBe(false);
    expect(session.cars.map((c) => c.cellId)).toEqual(cells);
    expect(session.logLines.at(-1)).toMatch(/^Action rejected/);
  });

  it("estimates the stint from tire and fuel, and shows no pit chip early in a short race", () => {
    const session = solo({ botCars: 1 });
    const stintOf = () => stintEstimate(session.cars.find((c) => c.carId === 1)!, session.ctx.trackIndex.spineLen);
    expect(hud(session).cars.find((c) => c.carId === 1)).toMatchObject({ stint: stintOf(), advice: "no-need" });
    playMyTurn(session);
    const mine = hud(session).cars.find((c) => c.carId === 1)!;
    expect(mine.stint).toEqual(stintOf());
    expect(mine.stint.laps).toBeGreaterThan(2);
    expect(mine.advice).toBe("no-need");
  });

  it("the pit modal's stints are for a full refill at the chosen setup", () => {
    const session = solo();
    const setup = session.activeCar.setup;
    const stints = session.pitStints(setup);
    expect(stints.soft.cells).toBeLessThan(stints.hard.cells);
    expect(stints.hard).toEqual(stintEstimate({ tire: 100, fuel: 100, setup: { ...setup, compound: "hard" } }, session.ctx.trackIndex.spineLen));
  });

  it("the hover tooltip carries the target's cost, and only while cars and moves are shown", () => {
    const session = solo();
    session.recomputeTargets();
    const [cellId, target] = [...session.validTargets].find(([, t]) => !t.isPitTrigger)!;
    const hoverCell = session.cellMap.get(cellId)!;
    const car = session.activeCar;
    expect(hud(session, { hoverCell }).hover).toEqual({
      ...AT,
      distance: target.distance,
      moveSpend: target.moveSpend ?? session.moveSpendOf(target, hoverCell.laneIndex),
      tireCost: target.tireCost,
      fuelCost: target.fuelCost,
      isPit: false,
      ...(target.laneChanges ? { laneChanges: target.laneChanges } : {}),
      tireBefore: car.tire,
      fuelBefore: car.fuel
    });
    expect(session.resourcesAfter(target)).toEqual({ tire: car.tire - target.tireCost, fuel: car.fuel - target.fuelCost });
    expect(hud(session, { hoverCell, showCarsAndMoves: false }).hover).toBeNull();
    expect(hud(session, { hoverCell: session.cellMap.get(car.cellId)! }).hover).toBeNull(); // not a target
    expect(hud(session).boxedIn).toBe(false);
  });

  it("the F overlay adds the cell debug text", () => {
    const session = solo();
    session.recomputeTargets();
    expect(hud(session).debugText).toBeNull();
    expect(hud(session, { showForwardIndex: true }).debugText).toMatch(/^Active: Car 1\nLap: 1\/2/);
    const [cellId] = [...session.validTargets].find(([, t]) => !t.isPitTrigger)!;
    const text = hud(session, { showForwardIndex: true, hoverCell: session.cellMap.get(cellId)! }).debugText!;
    expect(text).toContain(`cell: ${cellId}`);
    expect(text).toMatch(/\ntarget: d\d+ {2}tire-/);
    expect(text).toMatch(/\nfactors: aero x/);
  });

  it("lap and final-lap feel events are for my car only, and never on the first snapshot", () => {
    const session = solo({ botCars: 1, raceLaps: 3 });
    expect(session.drainFeel()).toEqual([]); // the first snapshot only seeds
    const laps: Array<{ lap: number; final: boolean; mine: number }> = [];
    for (let turn = 0; turn < 60 && !session.finished; turn += 1) {
      playMyTurn(session);
      for (const event of session.drainFeel()) {
        if (event.type === "move") expect(event).toEqual({ type: "move" });
        if (event.type === "lap") laps.push({ lap: event.lap, final: event.final, mine: session.localCar()!.lapCount ?? 0 });
      }
    }
    // the bot crossed the line as well; only my crossings toast, and the race-ending one is the finish instead
    expect(laps).toEqual([
      { lap: 2, final: false, mine: 1 },
      { lap: 3, final: true, mine: 2 }
    ]);
  });

  it("a full race against bots plays to the end through the session and announces the finish once", () => {
    const session = solo({ botCars: 2, raceLaps: 1, botLevel: "hard" });
    expect(session.cars.map((c) => c.botLevel ?? null)).toEqual([null, "hard", "hard"]);
    session.drainFeel();
    expect(session.takeFinish()).toBe(false);
    let finishEvents = 0;
    for (let turn = 0; turn < 60 && !session.finished; turn += 1) {
      playMyTurn(session);
      finishEvents += session.drainFeel().filter((e) => e.type === "finish").length;
    }
    expect(session.finished).toBe(true);
    expect(finishEvents).toBe(1);
    expect(session.takeFinish()).toBe(true);
    expect(session.takeFinish()).toBe(false);
    const snap = hud(session);
    expect(snap.finished).toBe(true);
    expect(snap.canControl).toBe(false);
    expect(snap.winnerCarId).toBe(session.winnerCarId);
    expect(snap.cars[0]).toMatchObject({ carId: session.winnerCarId, finished: true });
    // no more moves once it is over
    session.recomputeTargets();
    expect(session.validTargets.size).toBe(0);
    expect(session.canSkip()).toBe(false);
    expect(session.runBots()).toBe(0);
    // every bot turn is in the decision log
    expect(session.botDecisionLog.length).toBeGreaterThan(0);
    expect(session.botDecisionSnapshot(true)).toMatchObject({ shortMode: true, botDecisionCount: session.botDecisionLog.length });
  });

  it("the debug snapshot is the e2e hook's view of the race", () => {
    const session = solo();
    session.recomputeTargets();
    const snap = session.debugSnapshot();
    expect(snap.activeCarId).toBe(1);
    expect(snap.cars).toHaveLength(3);
    expect(snap.movement.validTargets).toHaveLength(session.validTargets.size);
    expect(snap.seed).toBe(0);
  });

  it("shows a bot's seeded style, and nothing for seed 0", () => {
    expect(hud(solo()).cars.every((c) => c.style === undefined)).toBe(true);
    const seeded = hud(solo({ seed: 7 }));
    expect(seeded.cars.filter((c) => c.style).map((c) => c.isBot)).toEqual([true, true]);
    expect(hud(solo({ botLevel: "hard" })).cars.filter((c) => c.style)).toHaveLength(2);
  });

  it("keeps the last 30 log lines", () => {
    const session = solo();
    for (let i = 0; i < 40; i += 1) session.addLog(`line ${i}`);
    expect(session.logLines).toHaveLength(30);
    expect(session.logLines[0]).toBe("line 10");
  });
});

// ---- online --------------------------------------------------------------------------------------------------------

const PLAYERS = [
  { playerId: "host", name: "Host" },
  { playerId: "guest", name: "Guest" }
];
const SEATS: RaceSeat[] = PLAYERS.map((p) => ({ isBot: false, ownerId: p.playerId }));

// What the server sends: its engine race as a lobby (carId = seatIndex + 1).
function lobbyOf(race: RaceState, over: Partial<PublicLobby> = {}): PublicLobby {
  const active = getActiveCar(race);
  return {
    lobbyId: "L1",
    status: race.winnerCarId === null ? "IN_RACE" : "FINISHED",
    hostPlayerId: "host",
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    settings: {
      trackId: "oval16_3lanes",
      totalCars: race.cars.length,
      humanCars: race.cars.filter((c) => !c.isBot).length,
      botCars: race.cars.filter((c) => c.isBot).length,
      raceLaps: race.raceLaps,
      turnTimerSec: 60,
      botLevel: "normal"
    },
    players: PLAYERS.map((p, seatIndex) => ({ ...p, connected: true, seatIndex, isHost: p.playerId === "host" })),
    raceState: {
      trackId: "oval16_3lanes",
      raceLaps: race.raceLaps,
      turnIndex: 0,
      activeSeatIndex: active.carId - 1,
      winnerCarId: race.winnerCarId,
      seed: race.seed,
      cars: race.cars.map((car) => ({
        ...structuredClone(car),
        seatIndex: car.carId - 1,
        playerId: car.isBot ? null : car.ownerId,
        name: PLAYERS[car.carId - 1]?.name ?? `Bot ${car.carId}`
      }))
    },
    ...over
  };
}

// The server applies the active player's furthest move.
function serverMove(server: { race: RaceState; ctx: RaceSession["ctx"] }) {
  const targets = computeTargets(server.ctx, server.race, getActiveCar(server.race));
  const best = [...targets].filter(([, t]) => !t.isPitTrigger).sort((a, b) => b[1].distance - a[1].distance)[0]!;
  const result = applyAction(server.ctx, server.race, { type: "move", targetCellId: best[0] });
  expect(result.ok).toBe(true);
}

function online(localPlayerId: string) {
  // The page starts the scene from the lobby settings, then takes the server's state.
  const session = new RaceSession(TRACK, { totalCars: 2, humanCars: 2, botCars: 0, raceLaps: 2, seed: 0 });
  const server = { ctx: session.ctx, race: createRace(session.ctx, SEATS, 2, 0) };
  expect(session.applyServerState(lobbyOf(server.race), localPlayerId)).toEqual({ respawned: false, applied: true });
  return { session, server };
}

describe("RaceSession: online", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("knows the local car by seat and lets only its player control it", () => {
    const host = online("host").session;
    const guest = online("guest").session;
    expect(host.online).toBe(true);
    expect(hud(host)).toMatchObject({ myCarId: 1, activeCarId: 1, canControl: true });
    expect(hud(guest)).toMatchObject({ myCarId: 2, activeCarId: 1, canControl: false });
    expect(hud(guest).cars.map((c) => c.name)).toEqual(["Host", "Guest"]);
    // nothing to offer the guest while it is the host's turn
    guest.recomputeTargets();
    expect(guest.validTargets.size).toBe(0);
    expect(guest.canSkip()).toBe(false);
    host.recomputeTargets();
    expect(host.validTargets.size).toBeGreaterThan(0);
  });

  it("the turn banner fields switch when the other player moves", () => {
    const { session: guest, server } = online("guest");
    serverMove(server);
    guest.applyServerState(lobbyOf(server.race), "guest");
    expect(hud(guest)).toMatchObject({ myCarId: 2, activeCarId: 2, canControl: true });
    serverMove(server);
    guest.applyServerState(lobbyOf(server.race), "guest");
    expect(hud(guest)).toMatchObject({ activeCarId: 1, canControl: false });
  });

  it("without a seat (spectating) nobody controls anything", () => {
    const { session } = online("host");
    session.applyServerState(lobbyOf(createRace(session.ctx, SEATS, 2, 0)), null);
    expect(session.localCar()).toBeUndefined();
    expect(session.canControlActiveCar()).toBe(false);
  });

  it("holds the dropped car on its target cell while the server is slow, and lets go when it answers", () => {
    vi.useFakeTimers();
    const { session, server } = online("host");
    session.recomputeTargets();
    const action = furthestMove(session);
    const cells = session.cars.map((c) => c.cellId);

    expect(session.applyLocal(action)).toBe(true);
    // the server moves the car, not the page: the state is untouched, and the car is held where it was dropped
    expect(session.cars.map((c) => c.cellId)).toEqual(cells);
    expect(session.heldCarId()).toBe(1);
    expect(session.canControlActiveCar()).toBe(false);
    expect(hud(session).canControl).toBe(false);
    session.recomputeTargets();
    expect(session.validTargets.size).toBe(0);
    expect(session.runBots()).toBe(0); // online the server plays the bots

    vi.advanceTimersByTime(SERVER_WAIT_MS - 100);
    expect(session.heldCarId()).toBe(1);
    expect(session.releaseServerWait()).toBe(false);

    applyAction(server.ctx, server.race, action);
    session.applyServerState(lobbyOf(server.race), "host");
    expect(session.heldCarId()).toBeNull();
    expect(session.cars[0]!.cellId).toBe(action.type === "move" ? action.targetCellId : "");
    vi.advanceTimersByTime(200);
    expect(session.releaseServerWait()).toBe(false); // nothing left to release
  });

  it("unlocks by itself when the server never answers", () => {
    vi.useFakeTimers();
    const { session } = online("host");
    session.recomputeTargets();
    session.applyLocal(furthestMove(session));
    vi.advanceTimersByTime(SERVER_WAIT_MS);
    expect(session.releaseServerWait()).toBe(true);
    expect(session.heldCarId()).toBeNull();
    expect(session.canControlActiveCar()).toBe(true);
  });

  it("joining mid-race seeds the feel memory: no toast for laps already done", () => {
    const { session, server } = online("host");
    session.drainFeel();
    const rejoin = new RaceSession(TRACK, { totalCars: 2, humanCars: 2, botCars: 0, raceLaps: 2, seed: 0 });
    rejoin.drainFeel(); // the scene's first render, before the server state
    server.race.cars[0]!.lapCount = 1;
    rejoin.applyServerState(lobbyOf(server.race), "host");
    expect(rejoin.drainFeel()).toEqual([]);
    // a lap crossed while watching does toast
    session.applyServerState(lobbyOf(server.race), "host");
    expect(session.drainFeel()).toContainEqual({ type: "lap", lap: 2, laps: 2, final: true });
  });

  it("another player's lap is not my toast, even while their car is the active one", () => {
    const { session: guest, server } = online("guest");
    guest.drainFeel();
    server.race.cars[0]!.lapCount = 1;
    guest.applyServerState(lobbyOf(server.race), "guest");
    expect(guest.activeCar.carId).toBe(1);
    expect(guest.drainFeel()).toEqual([]);
  });

  it("logs the end of the race once, with the winner", () => {
    const { session, server } = online("guest");
    server.race.winnerCarId = 2;
    session.applyServerState(lobbyOf(server.race), "guest");
    session.applyServerState(lobbyOf(server.race), "guest");
    expect(session.logLines.filter((l) => l.startsWith("Race finished"))).toEqual(["Race finished. Car 2 wins the 2-lap race."]);
    expect(session.takeFinish()).toBe(true);
    expect(hud(session)).toMatchObject({ finished: true, winnerCarId: 2, canControl: false });
  });

  it("a new car composition rebuilds the local race; a lobby without a race leaves it there", () => {
    const session = solo({ botCars: 3 });
    const waiting = lobbyOf(createRace(session.ctx, SEATS, 2, 0), { status: "WAITING" });
    expect(session.applyServerState(waiting, "host")).toEqual({ respawned: true, applied: false });
    expect(session.cars).toHaveLength(2);
    expect(session.applyServerState(waiting, "host")).toEqual({ respawned: false, applied: false });
  });

  it("logs every applied turn, and who was auto-played", () => {
    const { session } = online("host");
    session.applyTurnApplied("L1", "guest", { type: "move", targetCellId: "Z02_L1_00" }, "timeout");
    session.applyTurnApplied("L1", "host", { type: "pit", targetCellId: "Z03_L0_00" });
    session.applyTurnApplied("L1", "guest", { type: "skip" }, "force_skip");
    session.applyTurnApplied("other", "host", { type: "skip" });
    session.applyTurnApplied("L1", "nobody", { type: "skip" });
    expect(session.logLines.slice(-5)).toEqual([
      "Car 2 was auto-played (timeout).",
      "Car 2 moved to Z02_L1_00.",
      "Car 1 pit stop at Z03_L0_00.",
      "Car 2 was auto-played (host skip).",
      "Car 2 skipped (no moves)."
    ]);
  });
});

// ---- sandbox -------------------------------------------------------------------------------------------------------

describe("RaceSession: sandbox", () => {
  it("starts editing: the bots wait and the active car's targets show, bot or not", () => {
    const session = solo({ sandbox: true });
    expect(session.editing).toBe(true);
    expect(hud(session).sandbox).toBe("edit");
    expect(session.sandboxSelect(2)).toBe(true);
    expect(session.sandboxSelect(2)).toBe(false); // already active
    expect(session.runBots()).toBe(0);
    session.recomputeTargets();
    expect(session.activeCar.carId).toBe(2);
    expect(session.validTargets.size).toBeGreaterThan(0);
    expect(session.canSkip()).toBe(false);
    expect(session.sandboxSnapshot()).toMatchObject({ editing: true, activeCarId: 2, carIds: [1, 2, 3], car: { isBot: true } });
  });

  it("edits, drops and loads positions without celebrating", () => {
    const session = solo({ sandbox: true });
    session.drainFeel();
    session.sandboxEdit(1, { lapCount: 1 });
    expect(session.cars[0]!.lapCount).toBe(1);
    expect(session.drainFeel()).toEqual([]); // the edit reseeded the memory
    session.drainFeel();

    const free = TRACK.cells.find((c) => c.laneIndex === 2 && !session.cars.some((car) => car.cellId === c.id))!;
    session.sandboxDrop(1, free.id);
    expect(session.cars[0]!.cellId).toBe(free.id);
    expect(session.drainFeel()).toEqual([]);
    session.sandboxDrop(1, null); // dropped away from any cell: nothing changes
    expect(session.cars[0]!.cellId).toBe(free.id);

    session.loadPosition("{nope");
    expect(session.logLines.at(-1)).toBe("Load refused: not JSON.");
    session.loadPosition(JSON.stringify(session.debugSnapshot()));
    expect(session.logLines.at(-1)).toBe("Position loaded.");

    session.setEditing(false);
    expect(hud(session).sandbox).toBe("play");
    expect(session.logLines.at(-1)).toBe("Sandbox: playing from here.");
  });
});

describe("RaceSession: tap to move", () => {
  const firstTarget = (session: RaceSession, pit = false) =>
    [...session.validTargets].find(([, t]) => t.isPitTrigger === pit)!;

  it("a picked target shows its card with the same numbers as the hover tooltip, and replaces the tooltip", () => {
    const session = solo();
    session.recomputeTargets();
    const [cellId] = firstTarget(session);
    const hoverCell = session.cellMap.get(cellId)!;
    const hover = hud(session, { hoverCell }).hover;

    expect(session.selectTarget(cellId)).toBe(true);
    const snap = hud(session, { hoverCell });
    expect(snap.selection).toEqual(hover);
    expect(snap.hover).toBeNull();
    expect(session.selectedTarget()?.cellId).toBe(cellId);
    expect(hud(session, { showCarsAndMoves: false }).selection).toBeNull();
  });

  it("a pit-box target is flagged, so the card offers a pit stop", () => {
    const session = solo();
    const car = session.activeCar;
    car.cellId = "Z01_L0_00"; // PIT_LINE: the boxes are offered next
    session.recomputeTargets();
    const [cellId] = firstTarget(session, true);
    session.selectTarget(cellId);
    expect(hud(session).selection?.isPit).toBe(true);
  });

  it("only one of the player's own targets can be picked, and Cancel drops it", () => {
    const session = solo();
    session.recomputeTargets();
    expect(session.selectTarget(session.activeCar.cellId)).toBe(false); // not a target
    expect(hud(session).selection).toBeNull();
    const [cellId] = firstTarget(session);
    session.selectTarget(cellId);
    session.clearSelection();
    expect(session.selectedTarget()).toBeNull();
    expect(hud(session).selection).toBeNull();
  });

  it("the pick goes away when the turn is played, and does not come back on a later turn", () => {
    const session = solo();
    session.recomputeTargets();
    const [cellId] = firstTarget(session);
    session.selectTarget(cellId);
    playMyTurn(session);
    expect(session.selectedTarget()).toBeNull();
    expect(hud(session).selection).toBeNull();
  });

  it("online: nothing can be picked on the other player's turn, and the pick goes while the server answers", () => {
    vi.useFakeTimers();
    const guest = online("guest").session;
    guest.recomputeTargets();
    expect(guest.selectTarget("Z02_L1_00")).toBe(false);

    const { session: host, server } = online("host");
    host.recomputeTargets();
    const [cellId] = firstTarget(host);
    host.selectTarget(cellId);
    host.applyLocal({ type: "move", targetCellId: cellId });
    expect(host.selectedTarget()).toBeNull();

    vi.advanceTimersByTime(SERVER_WAIT_MS); // no answer: the input unlocks again
    host.releaseServerWait();
    host.recomputeTargets();
    const [again] = firstTarget(host);
    host.selectTarget(again);
    host.applyServerState(lobbyOf(server.race), "host");
    expect(host.selectedTarget()).toBeNull();
    vi.useRealTimers();
  });

  it("the sandbox editor never picks: dragging is how cars move there", () => {
    const session = solo({ sandbox: true });
    session.recomputeTargets();
    const [cellId] = firstTarget(session);
    expect(session.selectTarget(cellId)).toBe(false);
  });
});
