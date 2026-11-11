/** The pill's Home link goes back to the forge page the visitor left (#11295); a foreign referrer is ignored. */
import { expect, test } from "bun:test";
import { toolbarJs } from "../src/apps/toolbar.ts";

/** Run the client against a fake document; returns the Home link's href. */
function homeHref(referrer: string): string | undefined {
  const links: any[] = [];
  const el = (): any => {
    const e: any = { style: {}, dataset: {}, children: [], hidden: false,
      appendChild(c: any) { return c; }, setAttribute() {}, addEventListener() {},
      attachShadow: () => el(), classList: { add() {}, remove() {} } };
    return e;
  };
  const doc: any = {
    referrer, currentScript: { dataset: { forge: "https://forge.test" } },
    createElement: () => { const e = el(); links.push(e); return e; },
    addEventListener() {}, body: el(), documentElement: el(),
  };
  const win: any = { location: { origin: "https://app.test", pathname: "/" }, addEventListener() {}, matchMedia: () => ({ matches: false }) };
  new Function("window", "document", "location", "localStorage", "fetch", "URL", "setTimeout", "setInterval", "requestAnimationFrame", toolbarJs)(
      win, doc, win.location, { getItem: () => null, setItem() {} }, () => new Promise(() => {}), URL, () => 0, () => 0, () => 0);
  const home = links.find((l) => l.textContent === "Home");
  expect(home).toBeDefined();
  expect(home.href).toBeString();
  return home.href;
}

test("a same-origin forge referrer is the Home target", () => {
  expect(homeHref("https://forge.test/trevato/forge/pulls/7?x=1#top")).toBe("https://forge.test/trevato/forge/pulls/7?x=1");
});

test("Home is an anchor, and Escape closes the panel", () => {
  expect(toolbarJs).toContain('link.textContent = "Home"');
  expect(toolbarJs).toMatch(/e\.key !== "Escape" \|\| panel\.hidden/);
  expect(toolbarJs).toContain('document.createElement("a")');
});

test("a foreign or malformed referrer falls back to the forge's /", () => {
  expect(homeHref("https://evil.test/trevato/forge")).toBe("https://forge.test/");
  expect(homeHref("javascript:alert(1)")).toBe("https://forge.test/");
  expect(homeHref("")).toBe("https://forge.test/");
});
