import { describe, expect, it } from "vitest";
import { legacyInviteRoute, parseRoute, routePath, screenOf, type Route } from "./router";

describe("router", () => {
  const routes: Route[] = [
    { name: "home" },
    { name: "solo" },
    { name: "soloRace" },
    { name: "lobby", id: "abc-123" },
    { name: "lobbyRace", id: "abc-123" }
  ];

  it.each(["/", "/repo/"])("round-trips every route under base %s", (base) => {
    for (const route of routes) {
      expect(parseRoute(routePath(route, base), base)).toEqual(route);
    }
  });

  it("builds base-aware paths", () => {
    expect(routePath({ name: "lobby", id: "x" }, "/srp/")).toBe("/srp/lobby/x");
    expect(routePath({ name: "home" }, "/srp/")).toBe("/srp/");
  });

  it("tolerates trailing slashes and falls back to home", () => {
    expect(parseRoute("/solo/", "/")).toEqual({ name: "solo" });
    expect(parseRoute("/nope/at/all", "/")).toEqual({ name: "home" });
    expect(parseRoute("/lobby/", "/")).toEqual({ name: "home" });
  });

  it("maps routes to screens", () => {
    expect(routes.map(screenOf)).toEqual(["home", "lobby", "race", "lobby", "race"]);
  });

  it("redirects old ?lobby=ID links", () => {
    expect(legacyInviteRoute("?lobby=abc")).toEqual({ name: "lobby", id: "abc" });
    expect(legacyInviteRoute("?lobby=")).toBeNull();
    expect(legacyInviteRoute("")).toBeNull();
  });
});
