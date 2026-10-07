/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { isStale, mountVersion, renderVersion, versionReport, versionText } from "./version";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const web = { sha: SHA, date: "2026-10-07" };

describe("version text", () => {
  it("shows both short commits and the build day", () => {
    expect(versionText(web, { sha: SHA })).toBe("web 0123456 · 2026-10-07 · server 0123456");
  });

  it("says what it is waiting for and when the server cannot be reached", () => {
    expect(versionText(web, null)).toBe("web 0123456 · 2026-10-07 · server …");
    expect(versionText(web, "offline")).toBe("web 0123456 · 2026-10-07 · server offline");
    expect(versionText(web, { sha: "unknown" })).toContain("server unknown");
    expect(versionText({ sha: "unknown", date: "2026-10-07" }, null)).toContain("web unknown");
  });

  it("the report for a bug carries the full commits", () => {
    expect(versionReport(web, { sha: "f".repeat(40) })).toBe(
      `web ${SHA} (2026-10-07) · server ${"f".repeat(40)}`
    );
  });
});

describe("stale server", () => {
  it("is only flagged when both commits are known and differ", () => {
    expect(isStale(web, { sha: "f".repeat(40) })).toBe(true);
    expect(isStale(web, { sha: SHA })).toBe(false);
    expect(isStale(web, { sha: "unknown" })).toBe(false);
    expect(isStale(web, "offline")).toBe(false);
    expect(isStale(web, null)).toBe(false);
    expect(isStale({ sha: "unknown", date: "x" }, { sha: SHA })).toBe(false);
  });

  it("turns the label amber and explains why", () => {
    const el = document.createElement("button");
    renderVersion(el, web, { sha: "f".repeat(40) });
    expect(el.classList.contains("is-stale")).toBe(true);
    expect(el.title).toContain("another commit");
    renderVersion(el, web, { sha: SHA });
    expect(el.classList.contains("is-stale")).toBe(false);
  });
});

describe("mountVersion", () => {
  it("copies the full version on click and says so for a moment", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const el = document.createElement("button");
    let server: Parameters<typeof renderVersion>[2] = null;
    mountVersion(el, web, () => server);
    expect(el.textContent).toContain("server …");
    server = { sha: SHA };
    el.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith(`web ${SHA} (2026-10-07) · server ${SHA}`);
    expect(el.textContent).toBe("copied");
    await vi.advanceTimersByTimeAsync(1300);
    expect(el.textContent).toBe("web 0123456 · 2026-10-07 · server 0123456");
    vi.useRealTimers();
  });

  it("does nothing when the clipboard is unavailable", () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const el = document.createElement("button");
    mountVersion(el, web, () => null);
    expect(() => el.click()).not.toThrow();
  });
});
