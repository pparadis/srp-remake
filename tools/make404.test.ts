import { describe, expect, it } from "vitest";
import { build404 } from "./make404.mjs";

const INDEX = '<link rel="manifest" href="/srp-remake/manifest.webmanifest" />';

/** Runs the stub as a page at `pathname`; returns the file it asked for and what it wrote. */
function run(html: string, pathname: string) {
  let asked: string | null = null;
  let written: string | null = null;
  class FakeXhr {
    status = 200;
    responseText = "<html>the page</html>";
    open(_method: string, url: string) {
      asked = url;
    }
    send() {}
  }
  const doc = {
    open() {},
    write(text: string) {
      written = text;
    },
    close() {}
  };
  const code = /<script>(.*)<\/script>/s.exec(html)![1];
  // eslint-disable-next-line no-new-func -- the test runs the page script the generator emitted
  new Function("location", "XMLHttpRequest", "document", code)({ pathname }, FakeXhr, doc);
  return { asked, written };
}

describe("404 fallback (#96)", () => {
  const stub = build404(INDEX);

  it("loads the preview's own index.html for a path inside a preview", () => {
    expect(run(stub, "/srp-remake/pr-preview/pr-96/lobby/abc")).toEqual({
      asked: "/srp-remake/pr-preview/pr-96/index.html",
      written: "<html>the page</html>"
    });
    expect(run(stub, "/srp-remake/pr-preview/pr-7/").asked).toBe(
      "/srp-remake/pr-preview/pr-7/index.html"
    );
  });

  it("loads production's index.html for any other path", () => {
    expect(run(stub, "/srp-remake/lobby/abc").asked).toBe("/srp-remake/index.html");
    expect(run(stub, "/srp-remake/pr-preview/").asked).toBe("/srp-remake/index.html");
  });

  it("takes the base from the build, and is only the stub", () => {
    expect(run(build404('<link rel="manifest" href="/manifest.webmanifest">'), "/x").asked).toBe(
      "/index.html"
    );
    expect(stub).not.toContain("assets/");
  });
});
