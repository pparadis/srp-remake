// Tiny History API router. Paths are relative to Vite's BASE_URL (GitHub Pages serves under /<repo>/).
export type Route =
  | { name: "home" }
  | { name: "solo" }
  | { name: "soloRace" }
  | { name: "lobby"; id: string }
  | { name: "lobbyRace"; id: string };

export type Screen = "home" | "lobby" | "race";

const DEFAULT_BASE = import.meta.env.BASE_URL;

function stripBase(pathname: string, base: string): string {
  const root = base.replace(/\/+$/, "");
  const rest = root && pathname.startsWith(root) ? pathname.slice(root.length) : pathname;
  return rest.replace(/\/+$/, "") || "/";
}

export function parseRoute(pathname: string, base = DEFAULT_BASE): Route {
  const path = stripBase(pathname, base);
  if (path === "/solo") return { name: "solo" };
  if (path === "/solo/race") return { name: "soloRace" };
  const match = /^\/lobby\/([^/]+)(\/race)?$/.exec(path);
  if (match) {
    const id = decodeURIComponent(match[1]!);
    return match[2] ? { name: "lobbyRace", id } : { name: "lobby", id };
  }
  return { name: "home" };
}

export function routePath(route: Route, base = DEFAULT_BASE): string {
  const root = base.replace(/\/+$/, "");
  switch (route.name) {
    case "home":
      return `${root}/`;
    case "solo":
      return `${root}/solo`;
    case "soloRace":
      return `${root}/solo/race`;
    case "lobby":
      return `${root}/lobby/${encodeURIComponent(route.id)}`;
    case "lobbyRace":
      return `${root}/lobby/${encodeURIComponent(route.id)}/race`;
  }
}

export function screenOf(route: Route): Screen {
  if (route.name === "home") return "home";
  return route.name === "solo" || route.name === "lobby" ? "lobby" : "race";
}

/** Old invite links used `?lobby=ID`; returns the equivalent route, or null. */
export function legacyInviteRoute(search: string): Route | null {
  const id = new URLSearchParams(search).get("lobby")?.trim();
  return id ? { name: "lobby", id } : null;
}

type NavigateSource = "push" | "replace" | "pop";
type Handler = (route: Route, source: NavigateSource) => void;

let handler: Handler = () => {};

export function currentRoute(): Route {
  return parseRoute(window.location.pathname);
}

export function navigate(route: Route, mode: "push" | "replace" = "push") {
  const path = routePath(route);
  if (mode === "push") window.history.pushState({}, "", path);
  else window.history.replaceState({}, "", path);
  handler(route, mode);
}

/** Registers the route handler, wires back/forward and handles the first URL (incl. legacy ?lobby=). */
export function startRouter(onRoute: Handler) {
  handler = onRoute;
  window.addEventListener("popstate", () => onRoute(currentRoute(), "pop"));
  const legacy = legacyInviteRoute(window.location.search);
  if (legacy) navigate(legacy, "replace");
  else onRoute(currentRoute(), "replace");
}
