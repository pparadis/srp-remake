import "./style.css";

const app = document.getElementById("app")!;
const toggle = document.getElementById("extraPlayersToggle") as HTMLInputElement;
const select = document.getElementById("playerCountSelect") as HTMLSelectElement;
const botsToggle = document.getElementById("botsToggle") as HTMLInputElement;
const botModeToggle = document.getElementById("botModeToggle") as HTMLInputElement;
const restartBtn = document.getElementById("restartBtn") as HTMLButtonElement;

let game: ReturnType<typeof import("./game").startGame> | null = null;

function getPlayerCount() {
  if (!toggle.checked) return 1;
  const parsed = Number.parseInt(select.value, 10);
  return Number.isNaN(parsed) ? 2 : parsed;
}

function getBotFill() {
  return botsToggle?.checked ?? false;
}

function getBotMode() {
  return getBotFill() && (botModeToggle?.checked ?? false);
}

async function ensureGameStarted() {
  if (game) return;
  const { startGame } = await import("./game");
  game = startGame(app, { playerCount: getPlayerCount(), botFill: getBotFill(), botMode: getBotMode() });
}

async function restartGame() {
  if (game) {
    game.destroy(true);
    game = null;
  }
  await ensureGameStarted();
}

void ensureGameStarted();

toggle.addEventListener("change", () => {
  select.disabled = !toggle.checked;
});

botsToggle.addEventListener("change", () => {
  const enabled = botsToggle.checked;
  botModeToggle.disabled = !enabled;
  if (!enabled) {
    botModeToggle.checked = false;
  }
});

botModeToggle.disabled = !getBotFill();

restartBtn.addEventListener("click", () => {
  restartGame();
});
