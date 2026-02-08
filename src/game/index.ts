import Phaser from "phaser";
import { BootScene } from "./scenes/BootScene";
import { RaceScene } from "./scenes/RaceScene";
import { REG_BOT_CARS, REG_HUMAN_CARS, REG_RACE_LAPS, REG_TOTAL_CARS } from "./constants";

export interface GameOptions {
  totalCars?: number;
  humanCars?: number;
  botCars?: number;
  raceLaps?: number;
  // Legacy options kept for compatibility.
  playerCount?: number;
  botMode?: boolean;
  botFill?: boolean;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function resolveLegacyComposition(options: GameOptions): { totalCars: number; humanCars: number; botCars: number } {
  const totalCars = clampInt(options.playerCount ?? 1, 1, 11);
  const botMode = Boolean(options.botMode);
  const botFill = Boolean(options.botFill);
  if (botMode) return { totalCars, humanCars: 0, botCars: totalCars };
  if (botFill) return { totalCars, humanCars: 1, botCars: Math.max(0, totalCars - 1) };
  return { totalCars, humanCars: totalCars, botCars: 0 };
}

function resolveComposition(options: GameOptions): { totalCars: number; humanCars: number; botCars: number } {
  const hasExplicit =
    options.totalCars != null || options.humanCars != null || options.botCars != null;
  if (!hasExplicit) return resolveLegacyComposition(options);

  const requestedTotal = clampInt(
    options.totalCars ?? ((options.humanCars ?? 0) + (options.botCars ?? 0)),
    1,
    11
  );
  const requestedHumans = clampInt(options.humanCars ?? Math.max(0, requestedTotal - (options.botCars ?? 0)), 0, 11);
  const humanCars = Math.min(requestedHumans, requestedTotal);
  const requestedBots = clampInt(options.botCars ?? Math.max(0, requestedTotal - humanCars), 0, 11);
  const botCars = Math.min(requestedBots, requestedTotal - humanCars);
  return { totalCars: humanCars + botCars, humanCars, botCars };
}

export function startGame(parent: HTMLElement, options: GameOptions = {}) {
  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    parent,
    width: 1600,
    height: 900,
    backgroundColor: "#0b0f14",
    scene: [BootScene, RaceScene],
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH
    }
  };
  (config as { resolution?: number }).resolution = window.devicePixelRatio ?? 1;

  const game = new Phaser.Game(config);
  const composition = resolveComposition(options);
  const raceLaps = clampInt(options.raceLaps ?? 5, 1, 999);
  game.registry.set(REG_TOTAL_CARS, composition.totalCars);
  game.registry.set(REG_HUMAN_CARS, composition.humanCars);
  game.registry.set(REG_BOT_CARS, composition.botCars);
  game.registry.set(REG_RACE_LAPS, raceLaps);
  return game;
}
