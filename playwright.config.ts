import { defineConfig, devices } from "@playwright/test";

const port = process.env.E2E_PORT ?? "5173";
// Override when 3001 is taken by a backend that may be out of date.
const backendPort = process.env.E2E_BACKEND_PORT ?? "3001";
const backendUrl = `http://localhost:${backendPort}`;

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
      env: { PORT: backendPort },
      reuseExistingServer: !process.env.CI
    },
    {
      command: `npm run dev -- --port ${port} --strictPort`,
      url: `http://localhost:${port}`,
      // vite.config.ts serves under /<repo>/ on GitHub Actions (for Pages); the specs use root paths.
      env: { VITE_BASE_PATH: "/", VITE_BACKEND_API_BASE_URL: backendUrl, VITE_BACKEND_WS_BASE_URL: "" },
      reuseExistingServer: !process.env.CI
    }
  ]
});
