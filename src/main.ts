import { startGame } from "./game";

const app = document.getElementById("app")!;
const toggle = document.getElementById("extraPlayersToggle") as HTMLInputElement;
const select = document.getElementById("playerCountSelect") as HTMLSelectElement;
const restartBtn = document.getElementById("restartBtn") as HTMLButtonElement;

let game = startGame(app, { playerCount: 1 });

function getPlayerCount() {
  if (!toggle.checked) return 1;
  const parsed = Number.parseInt(select.value, 10);
  return Number.isNaN(parsed) ? 2 : parsed;
}

function restartGame() {
  if (game) {
    game.destroy(true);
  }
  game = startGame(app, { playerCount: getPlayerCount() });
}

toggle.addEventListener("change", () => {
  select.disabled = !toggle.checked;
});

restartBtn.addEventListener("click", () => {
  restartGame();
});
