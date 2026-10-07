import { defineConfig, devices } from "@playwright/test";

const port = process.env.E2E_PORT ?? "5173";
// Override when 3001 is taken by a backend that may be out of date.
const backendPort = process.env.E2E_BACKEND_PORT ?? "3001";
const backendUrl = `http://localhost:${backendPort}`;
// E2E_DEV=1: old behaviour, a Vite dev server (HMR, no build step) for local debugging.
const useDevServer = !!process.env.E2E_DEV;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "on-first-retry",
    screenshot: "only-on-failure"
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npx --prefix backend tsx backend/src/server.ts",
      url: `${backendUrl}/health`,
      // Fast clocks so timer and grace-period behaviour fits in a test: a "120 s" turn lasts 12 s and the
      // host has 8 s to come back. A reused backend (reuseExistingServer, local only) would run with real
      // clocks and break e2e/afk.spec.ts; stop it or use another E2E_BACKEND_PORT.
      // BOT_SEED=0: neutral bots and the grid in car order, so the specs are deterministic.
      env: { PORT: backendPort, BOT_SEED: "0", TURN_TIMER_TIME_SCALE: "0.1", HOST_GRACE_SECONDS: "8" },
      reuseExistingServer: !process.env.CI
    },
    {
      // Default: build once in "test" mode (keeps the window.__srp hook) into dist-e2e and serve it statically,
      // so there is no cold dev server. The backend URL is baked in at build time.
      command: useDevServer
        ? `npm run dev -- --port ${port} --strictPort`
        : `npx vite build --mode test --outDir dist-e2e --emptyOutDir && npx vite preview --outDir dist-e2e --port ${port} --strictPort`,
      url: `http://localhost:${port}`,
      timeout: 120_000,
      // vite.config.ts serves under /<repo>/ on GitHub Actions (for Pages); the specs use root paths.
      env: { VITE_BASE_PATH: "/", VITE_BACKEND_API_BASE_URL: backendUrl, VITE_BACKEND_WS_BASE_URL: "" },
      // A reused preview server would serve a stale build (and possibly another backend URL), so only the
      // dev server, which always serves the current source, may be reused locally.
      reuseExistingServer: useDevServer && !process.env.CI
    }
  ]
});
