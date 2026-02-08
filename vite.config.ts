import { execSync } from "node:child_process";
import { defineConfig } from "vite";

const repoName = globalThis.process?.env?.GITHUB_REPOSITORY?.split("/")[1] ?? "";
const defaultBase = globalThis.process?.env?.GITHUB_ACTIONS === "true" && repoName ? `/${repoName}/` : "/";

export default defineConfig({
  base: globalThis.process?.env?.VITE_BASE_PATH ?? defaultBase,
  define: {
    __GIT_SHA__: JSON.stringify(
      globalThis.process?.env?.GIT_SHA ??
        (() => {
          try {
            return execSync("git rev-parse HEAD").toString().trim();
          } catch {
            return "unknown";
          }
        })()
    )
  },
  build: {
    // Phaser is intentionally large and isolated in its own vendor chunk.
    chunkSizeWarningLimit: 1300,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes("node_modules/phaser")) return "phaser";
          if (id.includes("node_modules/zod")) return "zod";
          return undefined;
        }
      }
    }
  }
});
