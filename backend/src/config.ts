import { execSync } from "node:child_process";
import { z } from "zod";

export const DEFAULT_HOST_GRACE_SECONDS = 45;
export const DEFAULT_LOBBY_IDLE_SECONDS = 3600;
export const DEFAULT_MAX_LOBBIES = 1000;

// "true" | "false" | a hop count, as Fastify's `trustProxy` takes it.
const TrustProxy = z
  .string()
  .regex(/^(true|false|\d+)$/, "TRUST_PROXY must be true, false or a hop count")
  .transform((value): boolean | number =>
    value === "true" ? true : value === "false" ? false : Number(value)
  );

const ConfigSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3001),
  CORS_ALLOWED_ORIGINS: z.string().default("*"),
  PLAYER_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  // How long a lobby survives its host's last socket closing (a page reload) before it ends.
  HOST_GRACE_SECONDS: z.coerce.number().positive().default(DEFAULT_HOST_GRACE_SECONDS),
  // A lobby with no open socket is reaped after this long without activity (a finished one after 10 minutes).
  LOBBY_IDLE_SECONDS: z.coerce.number().positive().default(DEFAULT_LOBBY_IDLE_SECONDS),
  // Backstop for the per-IP rate limit: creating a lobby over this many answers 503.
  MAX_LOBBIES: z.coerce.number().int().positive().default(DEFAULT_MAX_LOBBIES),
  // Read the client address from X-Forwarded-For. Only behind a proxy that sets it (Render); never when the
  // backend is reachable directly, or a client could fake the header to dodge the rate limit.
  TRUST_PROXY: TrustProxy.default(false),
  // Per-IP rate limit. Tests switch it off; a partial test config (field absent) is also off.
  RATE_LIMIT_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  // Test-only: multiplies turn-timer lengths (0.05 makes "30 s" last 1.5 s).
  TURN_TIMER_TIME_SCALE: z.coerce.number().positive().default(1),
  // The commit this server runs, reported by /health (the web page shows it next to its own).
  GIT_SHA: z.string().optional()
});

export type BackendConfig = z.infer<typeof ConfigSchema>;

type ProcessEnv = Record<string, string | undefined>;

// GIT_SHA wins; Render sets RENDER_GIT_COMMIT; a local checkout asks git.
function currentCommit(env: ProcessEnv): string {
  const fromEnv = env.GIT_SHA || env.RENDER_GIT_COMMIT;
  if (fromEnv) return fromEnv;
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}

export function loadConfig(env: ProcessEnv = process.env): BackendConfig {
  return ConfigSchema.parse({ ...env, GIT_SHA: currentCommit(env) });
}
