import { describe, expect, it, vi } from 'vitest';
import { STALE_PAGE_MESSAGE, importFresh, isChunkLoadError } from './lazy';

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value)
  };
}

const gone = () => Promise.reject(new TypeError('Importing a module script failed.'));

describe('stale chunks after a deploy', () => {
  it('knows the way each browser says a chunk is gone', () => {
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: x'))).toBe(
      true
    );
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Track oval16 not found (404).'))).toBe(false);
    expect(isChunkLoadError('something else')).toBe(false);
  });

  it('passes the module through when the chunk loads', async () => {
    const reload = vi.fn();
    await expect(importFresh(() => Promise.resolve({ ok: 1 }), reload, memory())).resolves.toEqual({
      ok: 1
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads the page once when the chunk is gone, and does not resolve meanwhile', async () => {
    const reload = vi.fn();
    const storage = memory();
    const result = importFresh(gone, reload, storage, () => 1_000_000);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(storage.getItem('srp:chunk-reload')).toBe('1000000');
    const settled = vi.fn();
    void result.then(settled, settled);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).not.toHaveBeenCalled();
  });

  it('says what to do when the reload did not help, instead of reloading again', async () => {
    const reload = vi.fn();
    const storage = memory({ 'srp:chunk-reload': '1000000' });
    await expect(importFresh(gone, reload, storage, () => 1_005_000)).rejects.toThrow(
      STALE_PAGE_MESSAGE
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads again for a later deploy, once the window has passed', async () => {
    const reload = vi.fn();
    const storage = memory({ 'srp:chunk-reload': '1000000' });
    void importFresh(gone, reload, storage, () => 1_100_000);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  it('with no session storage it cannot tell a loop from a first time: it says what to do', async () => {
    const reload = vi.fn();
    await expect(importFresh(gone, reload, null)).rejects.toThrow(STALE_PAGE_MESSAGE);
    expect(reload).not.toHaveBeenCalled();
  });

  it('hands on any other error as it is', async () => {
    const reload = vi.fn();
    const failure = new Error('boom');
    await expect(importFresh(() => Promise.reject(failure), reload, memory())).rejects.toBe(
      failure
    );
    expect(reload).not.toHaveBeenCalled();
  });
});
