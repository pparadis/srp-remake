// The build version shown bottom right on the home and lobby screens: the web commit and day, and the commit the
// server runs (from /health). A server on another commit than the page shows in amber: a deploy is pending.

export interface WebVersion {
  sha: string;
  date: string;
}

/** What the server said: its commit, "offline" when it could not be reached, null while waiting. */
export type ServerVersion = { sha: string } | "offline" | null;

const short = (sha: string) => (/^[0-9a-f]{8,}$/.test(sha) ? sha.slice(0, 7) : sha);
const known = (sha: string) => sha !== "" && sha !== "unknown";

function serverLabel(server: ServerVersion, format: (sha: string) => string): string {
  if (server === null) return "…";
  return server === "offline" ? "offline" : format(server.sha || "unknown");
}

export function versionText(web: WebVersion, server: ServerVersion): string {
  return `web ${short(web.sha)} · ${web.date} · server ${serverLabel(server, short)}`;
}

/** Both commits known and different. */
export function isStale(web: WebVersion, server: ServerVersion): boolean {
  return (
    server !== null &&
    server !== "offline" &&
    known(web.sha) &&
    known(server.sha) &&
    web.sha !== server.sha
  );
}

/** Full commits, for pasting into a bug report. */
export function versionReport(web: WebVersion, server: ServerVersion): string {
  return `web ${web.sha} (${web.date}) · server ${serverLabel(server, (sha) => sha)}`;
}

export function renderVersion(el: HTMLElement, web: WebVersion, server: ServerVersion) {
  const stale = isStale(web, server);
  el.textContent = versionText(web, server);
  el.classList.toggle("is-stale", stale);
  el.title = stale
    ? "The server runs another commit than this page (a deploy is pending). Click to copy."
    : "Click to copy the version";
}

/** Click copies the full version; the label says so for a moment. */
export function mountVersion(el: HTMLElement, web: WebVersion, getServer: () => ServerVersion) {
  renderVersion(el, web, getServer());
  el.addEventListener("click", () => {
    void navigator.clipboard
      ?.writeText(versionReport(web, getServer()))
      .then(() => {
        el.textContent = "copied";
        setTimeout(() => renderVersion(el, web, getServer()), 1200);
      })
      .catch(() => undefined);
  });
}
