import "./style.css";

const app = document.getElementById("app")!;
const toggle = document.getElementById("extraPlayersToggle") as HTMLInputElement;
const select = document.getElementById("playerCountSelect") as HTMLSelectElement;
const restartBtn = document.getElementById("restartBtn") as HTMLButtonElement;

let game: ReturnType<typeof import("./game").startGame> | null = null;

function getPlayerCount() {
  if (!toggle.checked) return 1;
  const parsed = Number.parseInt(select.value, 10);
  return Number.isNaN(parsed) ? 2 : parsed;
}

async function ensureGameStarted() {
  if (game) return;
  const { startGame } = await import("./game");
  game = startGame(app, { playerCount: getPlayerCount() });
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

restartBtn.addEventListener("click", () => {
  restartGame();
});
