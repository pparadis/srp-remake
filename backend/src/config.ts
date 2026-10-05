import { z } from "zod";

export const DEFAULT_HOST_GRACE_SECONDS = 45;

const ConfigSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3001),
  CORS_ALLOWED_ORIGINS: z.string().default("*"),
  PLAYER_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
  // How long a lobby survives its host's last socket closing (a page reload) before it ends.
  HOST_GRACE_SECONDS: z.coerce.number().positive().default(DEFAULT_HOST_GRACE_SECONDS),
  // Test-only: multiplies turn-timer lengths (0.05 makes "30 s" last 1.5 s).
  TURN_TIMER_TIME_SCALE: z.coerce.number().positive().default(1)
});

export type BackendConfig = z.infer<typeof ConfigSchema>;

type ProcessEnv = Record<string, string | undefined>;

export function loadConfig(env: ProcessEnv = process.env): BackendConfig {
  return ConfigSchema.parse(env);
}
