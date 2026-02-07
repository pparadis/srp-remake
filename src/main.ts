import "./style.css";

const app = document.getElementById("app")!;
const humanCountSelect = document.getElementById("humanCountSelect") as HTMLSelectElement;
const botCountSelect = document.getElementById("botCountSelect") as HTMLSelectElement;
const restartBtn = document.getElementById("restartBtn") as HTMLButtonElement;
const toggleCarsMovesBtn = document.getElementById("toggleCarsMovesBtn") as HTMLButtonElement | null;

let game: ReturnType<typeof import("./game").startGame> | null = null;

function parseSelectInt(select: HTMLSelectElement, fallback: number): number {
  const parsed = Number.parseInt(select.value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function getComposition() {
  let humanCars = Math.max(0, Math.min(11, parseSelectInt(humanCountSelect, 1)));
  let botCars = Math.max(0, Math.min(11, parseSelectInt(botCountSelect, 0)));
  if (humanCars + botCars === 0) {
    humanCars = 1;
    botCars = 0;
  }
  if (humanCars + botCars > 11) {
    const maxBots = Math.max(0, 11 - humanCars);
    botCars = Math.min(botCars, maxBots);
    if (humanCars + botCars > 11) {
      humanCars = 11;
      botCars = 0;
    }
  }
  const totalCars = humanCars + botCars;
  return { totalCars, humanCars, botCars };
}

async function ensureGameStarted() {
  if (game) return;
  const { startGame } = await import("./game");
  game = startGame(app, getComposition());
}

async function restartGame() {
  if (game) {
    game.destroy(true);
    game = null;
  }
  await ensureGameStarted();
}

void ensureGameStarted();

restartBtn.addEventListener("click", () => {
  restartGame();
});

toggleCarsMovesBtn?.addEventListener("click", () => {
  window.dispatchEvent(new Event("srp:toggle-cars-moves"));
});
