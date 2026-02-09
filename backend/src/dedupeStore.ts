export interface DedupeStore<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T, ttlSeconds: number): Promise<void>;
}

export interface RedisLikeClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX: number }): Promise<unknown>;
}

export class MemoryDedupeStore<T> implements DedupeStore<T> {
  private store = new Map<string, { value: T; expiresAt: number }>();

  async get(key: string): Promise<T | undefined> {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  async set(key: string, value: T, ttlSeconds: number): Promise<void> {
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.store.set(key, { value, expiresAt });
  }
}

export class RedisDedupeStore<T> implements DedupeStore<T> {
  constructor(private readonly redis: RedisLikeClient) {}

  async get(key: string): Promise<T | undefined> {
    const raw = await this.redis.get(key);
    if (!raw) return undefined;
    return JSON.parse(raw) as T;
  }

  async set(key: string, value: T, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, JSON.stringify(value), { EX: ttlSeconds });
  }
}
