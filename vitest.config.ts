import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __GIT_SHA__: JSON.stringify("0123456789abcdef0123456789abcdef01234567"), __BUILD_DATE__: JSON.stringify("2026-01-02") },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "jsdom",
    coverage: {
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/game/types/**",
        "src/game/scenes/**",
        "src/main.ts"
      ],
      thresholds: {
        statements: 92,
        branches: 80,
        functions: 92,
        lines: 95
      }
    }
  }
});
