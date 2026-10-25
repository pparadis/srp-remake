// The game, the recap and the replay are lazy chunks with hashed names. A deploy removes the old files, so a page loaded
// before it (a tab left open, a home-screen app on an older copy) asks for chunks that are gone, and the browser says
// "Importing a module script failed" (Safari) or "Failed to fetch dynamically imported module" (Chrome). The fix is the
// new page: reload once.

const RELOAD_KEY = 'srp:chunk-reload';
/** A second failure within this long means the reload did not help: say so instead of looping. */
const RELOAD_WINDOW_MS = 30_000;

export function isChunkLoadError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  return /importing a module script failed|failed to fetch dynamically imported module|error loading dynamically imported module|ChunkLoadError/i.test(
    text
  );
}

export const STALE_PAGE_MESSAGE = 'A new version was deployed: reload the page.';

/**
 * Runs `load` (a dynamic `import()`). When the chunk is gone, reloads the page once (it comes back to the same screen)
 * and never resolves meanwhile; if it fails again soon after, throws a message that says what to do. Any other error is
 * passed on unchanged.
 */
export async function importFresh<T>(
  load: () => Promise<T>,
  reload: () => void = () => window.location.reload(),
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeSessionStorage(),
  now: () => number = Date.now
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (!isChunkLoadError(error)) throw error;
    const last = Number(storage?.getItem(RELOAD_KEY) ?? 0);
    if (storage === null || now() - last < RELOAD_WINDOW_MS) throw new Error(STALE_PAGE_MESSAGE);
    storage.setItem(RELOAD_KEY, String(now()));
    reload();
    return new Promise<T>(() => {
      // the page is going away
    });
  }
}

function safeSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
