import { z } from "zod";

const ConfigSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3001),
  REDIS_URL: z.string().default("redis://redis:6379"),
  DEDUPE_TTL_SECONDS: z.coerce.number().int().positive().default(3600)
});

export type BackendConfig = z.infer<typeof ConfigSchema>;

type ProcessEnv = Record<string, string | undefined>;

export function loadConfig(env: ProcessEnv = process.env): BackendConfig {
  return ConfigSchema.parse(env);
}
