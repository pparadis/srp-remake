import { afterEach, describe, expect, it, vi } from "vitest";
import track from "../../../public/tracks/oval16_3lanes.json";
import type { TrackData } from "../types/track";
import type { PublicLobby } from "../../net/backendApi";
import type { Car } from "../types/car";
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

describe("RaceSession: grid setup", () => {
  const lowSoft = { compound: "soft" as const, psi: { fl: 32, fr: 32, rl: 32, rr: 32 }, wing: "low" as const };

  it("offers the setup to the player until the first move, and the HUD shows the wing and the budget", () => {
    const session = solo();
    session.recomputeTargets();
    expect(session.canSetup()).toBe(true);
    expect(hud(session).cars.find((c) => c.carId === 1)).toMatchObject({ wing: "medium", budget: 40, remaining: 40 });

    expect(session.applyLocal({ type: "setup", setup: lowSoft })).toBe(true);
    session.recomputeTargets();
    expect(session.activeCar.carId).toBe(1);
    expect(hud(session).cars.find((c) => c.carId === 1)).toMatchObject({
      compound: "soft",
      wing: "low",
      budget: 42,
      remaining: 42
    });

    playMyTurn(session);
    expect(session.canSetup()).toBe(false);
    expect(session.applyLocal({ type: "setup", setup: { ...lowSoft, wing: "high" } })).toBe(false);
  });

  it("is not offered to a bot's turn", () => {
    const session = solo();
    session.recomputeTargets();
    playMyTurn(session);
    const bot = session.cars.find((c) => c.isBot)!;
    expect(bot.setupLocked).toBe(true);
    expect(session.canSetup()).toBe(false);
  });
});

describe("RaceSession: drafting", () => {
  it("the HUD says who is drafting and for how many turns, and marks drafted and slingshot targets", () => {
    const session = solo();
    session.recomputeTargets();
    const me = session.activeCar;
    const other = session.cars.find((c) => c.carId !== me.carId)!;
    Object.assign(me, { cellId: "Z05_L1_00", draftTurns: 2 });
    Object.assign(other, { cellId: "Z07_L1_00" });
    session.recomputeTargets();

    const card = hud(session).cars.find((c) => c.carId === me.carId)!;
    expect(card).toMatchObject({ drafting: true, draftTurns: 2 });
    expect([...session.validTargets.values()].some((t) => t.slingshot)).toBe(true);
    expect(hud(session).cars.find((c) => c.carId === other.carId)).toMatchObject({ drafting: false });
  });

  // The test that was missing (issue #98): nothing here puts a car anywhere. A player who ends each move tucked in
  // behind a car whenever one is within reach gets the tow, the chip and the slingshot in a real race with real bots.
  it("a player who tucks in behind a car gets the tow and the slingshot in a real solo race", () => {
    const session = solo({ botCars: 3, raceLaps: 5 });
    let tows = 0;
    let readyTurns = 0;
    let fedBack = false;
    for (let turn = 0; turn < 60 && !session.finished; turn += 1) {
      session.recomputeTargets();
      const moves = [...session.validTargets].filter(([, t]) => !t.isPitTrigger);
      // The player starts on pole with every bot behind, so there is no car to tuck in behind: the first move is a short
      // one (4 cells), the bots pass and are then within one move. After that: a slingshot lane change when one is
      // open, else a move that ends tucked in behind a car, else the furthest.
      const byDistance = [...moves].sort((a, b) => b[1].distance - a[1].distance);
      const tucked = moves.filter(([id]) => session.endsTucked(id)).sort((a, b) => b[1].distance - a[1].distance);
      const short = [...moves].sort((a, b) => Math.abs(a[1].distance - 4) - Math.abs(b[1].distance - 4))[0];
      const pick = turn === 0 ? short : (moves.find(([, t]) => t.slingshot) ?? tucked[0] ?? byDistance[0]);
      if (!pick) break;
      const me = session.localCar()!;
      const card = hud(session).cars.find((c) => c.carId === me.carId)!;
      if (card.drafting) tows += 1;
      if (card.draftTurns >= 2) readyTurns += 1;
      // the tow is on the board for every car that has one, and the player's is in the list
      if (card.drafting) fedBack ||= session.draftLinks().some((l) => l.carId === me.carId);
      expect(session.applyLocal({ type: "move", targetCellId: pick[0] })).toBe(true);
      session.runBots();
    }
    expect(tows, "turns that began in the tow").toBeGreaterThanOrEqual(2);
    expect(fedBack).toBe(true);
    expect(readyTurns, "turns with the slingshot open").toBeGreaterThan(0);
    expect(session.localCar()!.slingshots ?? 0).toBeGreaterThan(0);
  });

  it("draftLinks lists the cars in a tow: the cells to the car ahead while it is there, the range once it has gone", () => {
    const session = solo({ botCars: 2 });
    const [me, bot] = session.cars as [Car, Car];
    Object.assign(me, { cellId: "Z05_L1_00", draftTurns: 1 });
    Object.assign(bot, { cellId: "Z07_L1_00", draftTurns: 2 });
    expect(session.draftLinks()).toEqual([
      { carId: me.carId, gap: 2, ready: false },
      // the bot's tow: nothing ahead of it within the range, so the run is the range
      { carId: bot.carId, gap: 2, ready: true }
    ]);
    Object.assign(bot, { cellId: "Z12_L1_00" });
    expect(session.draftLinks().find((l) => l.carId === me.carId)).toMatchObject({ gap: 2, ready: false });
    Object.assign(me, { draftTurns: 0 });
    expect(session.draftLinks().map((l) => l.carId)).toEqual([bot.carId]); // a car with no run has no tow
  });

  it("endsTucked says which cells keep or start the tow, in the car's own lane only", () => {
    const session = solo({ botCars: 1 });
    const [me, bot] = session.cars as [Car, Car];
    Object.assign(me, { cellId: "Z05_L1_00" });
    Object.assign(bot, { cellId: "Z09_L1_00" });
    expect(session.endsTucked("Z07_L1_00")).toBe(true); // 2 behind
    expect(session.endsTucked("Z08_L1_00")).toBe(true); // 1 behind
    expect(session.endsTucked("Z06_L1_00")).toBe(false); // 3 behind
    expect(session.endsTucked("Z08_L2_00")).toBe(false); // beside it, another lane
    session.recomputeTargets();
    const [id] = [...session.validTargets.keys()];
    expect(session.selectTarget(id!)).toBe(true);
  });
});

describe("RaceSession: rules version (#118)", () => {
  it("plays the default rules unless told otherwise, and the snapshot says which", () => {
    expect(solo().race.rulesVersion).toBe("v2");
    expect(solo().debugSnapshot().rulesVersion).toBe("v2");
  });

  it("a solo race on v1 plays v1, and the snapshot says so", () => {
    const session = solo({ rulesVersion: "v1" });
    expect(session.race.rulesVersion).toBe("v1");
    expect(session.debugSnapshot().rulesVersion).toBe("v1");
  });

  it("the rules decide the tow: Z12_L3 right behind Z13_L3 is tucked in on v2, not on v1 (#113)", () => {
    const tucked = (version: "v1" | "v2") => {
      const session = solo({ botCars: 1, rulesVersion: version });
      const [me, bot] = session.cars as [Car, Car];
      Object.assign(me, { cellId: "Z05_L1_00" });
      Object.assign(bot, { cellId: "Z13_L3_00" });
      return session.endsTucked("Z12_L3_00");
    };
    expect(tucked("v2")).toBe(true);
    expect(tucked("v1")).toBe(false);
  });
});

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

  it("the standings rank neighbours of an outer lane by lap position, and the gap is in whole cells (#113)", () => {
    const session = solo({ botCars: 1 });
    const [me, bot] = session.cars as [Car, Car];
    // Z12_L3 and Z13_L3 share forwardIndex 10, and the car ids would have put car 1 ahead
    Object.assign(me, { cellId: "Z12_L3_00" });
    Object.assign(bot, { cellId: "Z13_L3_00" });
    const snap = hud(session);
    expect(snap.cars.map((c) => c.carId)).toEqual([2, 1]);
    const [lead, chaser] = snap.cars as [(typeof snap.cars)[number], (typeof snap.cars)[number]];
    expect(lead.progress).toBeGreaterThan(chaser.progress);
    expect(Math.round(lead.progress - chaser.progress)).toBe(1);
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
    expect(text).toMatch(/\nfactors: aeroT x/);
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

  it("tells the board which cars moved, in the order they moved: the player first, then the bots in turn order", () => {
    const session = solo({ botCars: 3 });
    expect(session.drainMoves()).toEqual([]);
    playMyTurn(session);
    // car 1 is on pole and plays first; the bots follow in turn order
    expect(session.drainMoves()).toEqual([1, 2, 3, 4]);
    expect(session.drainMoves()).toEqual([]); // drained
    // a setup is not a move
    session.recomputeTargets();
    const before = session.activeCar.cellId;
    session.applyLocal({ type: "setup", setup: { ...session.activeCar.setup, wing: "low" } });
    expect(session.activeCar.cellId).toBe(before);
    expect(session.drainMoves()).toEqual([]);
  });

  it("previews the path of the picked target, else the hovered one, and nothing for a cell that is no target", () => {
    const session = solo({ botCars: 2 });
    session.recomputeTargets();
    const start = session.activeCar.cellId;
    const targets = [...session.validTargets.keys()];
    const [a, b] = [targets[0]!, targets[targets.length - 1]!];
    expect(a).not.toBe(b);

    expect(session.previewFor(null)).toBeNull();
    expect(session.previewFor("Z20_L3_00")).toBeNull(); // not one of its targets
    const hovered = session.previewFor(a)!;
    expect(hovered).toMatchObject({ cellId: a, kind: "move" });
    expect(hovered.cells[0]).toBe(start);
    expect(hovered.cells.at(-1)).toBe(a);

    // a tapped target wins over what the pointer is on
    expect(session.selectTarget(b)).toBe(true);
    expect(session.previewFor(a)!.cellId).toBe(b);
    session.clearSelection();
    expect(session.previewFor(a)!.cellId).toBe(a);
  });

  it("previews a pit stop as a pit path, a slingshot as a slingshot, and nothing off turn or in edit mode", () => {
    const session = solo({ botCars: 1 });
    const [me, bot] = session.cars as [Car, Car];
    Object.assign(me, { cellId: "Z05_L1_00", draftTurns: 2 });
    Object.assign(bot, { cellId: "Z07_L1_00" });
    session.recomputeTargets();
    const sling = [...session.validTargets].find(([, t]) => t.slingshot)!;
    expect(session.previewFor(sling[0])).toMatchObject({ cellId: sling[0], kind: "slingshot" });
    // the walk goes round the car it passes, never through it
    expect(session.previewFor(sling[0])!.cells).not.toContain("Z07_L1_00");

    Object.assign(me, { cellId: "Z27_L1_00" });
    Object.assign(bot, { cellId: "Z20_L3_00" });
    session.recomputeTargets();
    const pit = [...session.validTargets].find(([, t]) => t.isPitTrigger);
    if (pit) expect(session.previewFor(pit[0])?.kind).toBe("pit");

    session.setEditing(true);
    expect(session.previewFor(sling[0])).toBeNull();
  });

  it("remembers each car's last path until it moves again: the player first, then the bots, round the cars in the way", () => {
    const session = solo({ botCars: 2 });
    expect(session.lastMovePath(1)).toEqual([]);
    const before = new Map(session.cars.map((c) => [c.carId, c.cellId]));
    playMyTurn(session);
    for (const car of session.cars) {
      const path = session.lastMovePath(car.carId);
      expect(path[0], `car ${car.carId}`).toBe(before.get(car.carId));
      expect(path.at(-1), `car ${car.carId}`).toBe(car.cellId);
      expect(path.length, `car ${car.carId}`).toBeGreaterThanOrEqual(2);
    }
    // a setup is not a move: the trail stays
    const mine = session.lastMovePath(1);
    playMyTurn(session);
    expect(session.lastMovePath(1)).not.toEqual(mine);
    expect(session.lastMovePath(1)[0]).toBe(mine.at(-1));
  });

  it("a slingshot: the target says the tow puts it in reach, and playing it toasts once and logs it", () => {
    const session = solo({ botCars: 1 });
    const [me, bot] = session.cars as [Car, Car];
    Object.assign(me, { cellId: "Z05_L1_00", draftTurns: 2 });
    Object.assign(bot, { cellId: "Z07_L1_00" });
    session.recomputeTargets();
    session.drainFeel();
    // 9 cells into lane 2 cost 10 without the slingshot: past the 9-move cap, so only the draft opens it
    const only = [...session.validTargets].find(([, t]) => t.slingshotOnly);
    expect(only).toBeDefined();
    expect(session.selectTarget(only![0])).toBe(true);
    expect(hud(session).selection).toMatchObject({ slingshot: true, slingshotOnly: true, moveSpend: 9 });

    expect(session.applyLocal({ type: "move", targetCellId: only![0] })).toBe(true);
    expect(session.drainFeel().filter((e) => e.type === "slingshot")).toHaveLength(1);
    expect(session.logLines).toContain("Car 1 slingshots.");
    expect(session.drainFeel().filter((e) => e.type === "slingshot")).toHaveLength(0);
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

  it("online, the cars that changed cell since the last state come in turn order from the car that was on turn", () => {
    const { session: guest, server } = online("guest");
    expect(guest.drainMoves()).toEqual([]); // the joining state is not a move
    serverMove(server); // car 1
    serverMove(server); // car 2
    guest.applyServerState(lobbyOf(server.race), "guest");
    expect(guest.drainMoves()).toEqual([1, 2]);
    guest.applyServerState(lobbyOf(server.race), "guest"); // the same state again
    expect(guest.drainMoves()).toEqual([]);
    serverMove(server); // car 1 again
    guest.applyServerState(lobbyOf(server.race), "guest");
    expect(guest.drainMoves()).toEqual([1]);
  });

  it("online, a car's last path comes from the diff of two server states, round the cars as they stood", () => {
    const { session: guest, server } = online("guest");
    const [c1] = server.race.cars as [Car, Car];
    const from = c1.cellId;
    serverMove(server); // car 1
    guest.applyServerState(lobbyOf(server.race), "guest");
    const path = guest.lastMovePath(1);
    expect(path[0]).toBe(from);
    expect(path.at(-1)).toBe(c1.cellId);
    expect(guest.lastMovePath(2)).toEqual([]); // it has not moved
  });

  it("logs another player's slingshot once from the server's counter", () => {
    const { session: guest, server } = online("guest");
    const [c1, c2] = server.race.cars as [Car, Car];
    Object.assign(c1, { cellId: "Z05_L1_00", draftTurns: 2 });
    Object.assign(c2, { cellId: "Z07_L1_00" });
    guest.applyServerState(lobbyOf(server.race), "guest");
    expect(applyAction(server.ctx, server.race, { type: "move", targetCellId: "Z08_L2_00" }).ok).toBe(true);
    expect(c1.slingshots).toBe(1);
    guest.applyServerState(lobbyOf(server.race), "guest");
    guest.applyServerState(lobbyOf(server.race), "guest"); // a repeated state is not a second slingshot
    expect(guest.logLines.filter((line) => line === "Car 1 slingshots.")).toHaveLength(1);
    // the guest's own feel: someone else's slingshot is no toast
    expect(guest.drainFeel().some((e) => e.type === "slingshot")).toBe(false);
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
