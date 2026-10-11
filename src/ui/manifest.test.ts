import { describe, expect, it } from "vitest";
import manifestText from "../../public/manifest.webmanifest?raw";
import indexHtml from "../../index.html?raw";
import faviconSvg from "../../public/icons/icon.svg?raw";
import icon192 from "../../public/icons/icon-192.png?inline";
import icon512 from "../../public/icons/icon-512.png?inline";
import iconMaskable from "../../public/icons/icon-maskable-512.png?inline";
import touchIcon from "../../public/icons/apple-touch-icon.png?inline";

// Add to Home Screen (issue #49): the manifest and the head tags that make the game an installable landscape app.
const manifest = JSON.parse(manifestText) as {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  orientation: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
};
const PNGS: Record<string, string> = {
  "icons/icon-192.png": icon192,
  "icons/icon-512.png": icon512,
  "icons/icon-maskable-512.png": iconMaskable,
  "icons/apple-touch-icon.png": touchIcon
};

/** Width x height from a PNG data URL's IHDR chunk. */
function pngSize(dataUrl: string | undefined): string {
  const bytes = Uint8Array.from(atob(dataUrl!.split(",")[1]!), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  expect(String.fromCharCode(...bytes.subarray(1, 4))).toBe("PNG");
  return `${view.getUint32(16)}x${view.getUint32(20)}`;
}

describe("web app manifest", () => {
  it("installs as a fullscreen landscape game", () => {
    expect(manifest).toMatchObject({
      name: "Street Racing Prototype",
      short_name: "Street Racing",
      display: "fullscreen",
      orientation: "landscape"
    });
  });

  it("uses relative URLs, so it works under the GitHub Pages base path too", () => {
    for (const url of [manifest.start_url, manifest.scope, ...manifest.icons.map((i) => i.src)]) {
      expect(url.startsWith("/"), url).toBe(false);
    }
  });

  it("has a 192 and a 512 icon, a maskable one, and every file is the size it declares", () => {
    expect(manifest.icons.map((i) => i.sizes)).toEqual(
      expect.arrayContaining(["192x192", "512x512"])
    );
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
    for (const icon of manifest.icons) expect(pngSize(PNGS[icon.src]), icon.src).toBe(icon.sizes);
  });

  it("is linked from index.html with the iOS home-screen tags, a 180 px touch icon and the SVG favicon", () => {
    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(indexHtml).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(indexHtml).toContain(
      '<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />'
    );
    expect(pngSize(PNGS["icons/apple-touch-icon.png"])).toBe("180x180");
    expect(indexHtml).toContain('<link rel="icon" type="image/svg+xml" href="/icons/icon.svg" />');
    expect(faviconSvg).toContain("<svg");
  });
});
