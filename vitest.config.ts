import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
