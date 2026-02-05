import { execSync } from "node:child_process";
import { defineConfig } from "vite";

export default defineConfig({
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
