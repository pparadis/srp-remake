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
    rollupOptions: {
      output: {
        manualChunks: {
          phaser: ["phaser"]
        }
      }
    }
  }
});
