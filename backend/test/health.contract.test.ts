import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, type BackendConfig } from "../src/config.js";
import { createApp } from "../src/server.js";

const BASE: BackendConfig = {
  HOST: "127.0.0.1",
  PORT: 3001,
  CORS_ALLOWED_ORIGINS: "*",
  PLAYER_TOKEN_TTL_SECONDS: 86400,
  HOST_GRACE_SECONDS: 45,
  TURN_TIMER_TIME_SCALE: 1
};

async function health(config: BackendConfig) {
  const app = await createApp(config, { logger: false });
  try {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    return res.json() as { ok: boolean; lobbies: number; sha: string };
  } finally {
    await app.close();
  }
}

test("/health reports the commit the server runs", async () => {
  assert.deepEqual(await health({ ...BASE, GIT_SHA: "abc1234def5678" }), {
    ok: true,
    lobbies: 0,
    sha: "abc1234def5678"
  });
});

test("/health says unknown when the commit is not configured", async () => {
  assert.equal((await health(BASE)).sha, "unknown");
});

test("the commit comes from GIT_SHA, then Render's RENDER_GIT_COMMIT, then git", () => {
  assert.equal(loadConfig({ GIT_SHA: "aaa", RENDER_GIT_COMMIT: "bbb" }).GIT_SHA, "aaa");
  assert.equal(loadConfig({ RENDER_GIT_COMMIT: "bbb" }).GIT_SHA, "bbb");
  // a checkout (CI, dev) answers from git, anything else is "unknown"
  assert.match(loadConfig({}).GIT_SHA ?? "", /^([0-9a-f]{40}|unknown)$/);
});
