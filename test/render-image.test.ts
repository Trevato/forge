/** Image kinds on the blob page: an <img> at the media route, never inline bytes. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { setCrawlClock } from "../src/http/crawl.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { renderBlob } from "../src/web/pages/repo.ts";
import type { RepoScope } from "../src/web/scope.ts";
import type { RefSet } from "../src/web/pages/refs.ts";
import { imageViewJs } from "../src/web/render/image.ts";
import { RENDER_CAP } from "../src/web/render/kinds.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

/** A PNG header that says 640 x 480. */
const PNG = new Uint8Array(32);
PNG.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 0x80, 0, 0, 1, 0xe0]);
const GIF = new TextEncoder().encode("GIF89a\x01\x00\x01\x00");
const WEBP = new TextEncoder().encode("RIFF\x10\x00\x00\x00WEBPVP8 ");
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect id="UNIQUE-RECT"/></svg>\n';

let dataDir = "";
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-image-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  // Each page is read in a minute of its own: the anonymous deep-page budget is not under test.
  let minute = 0;
  setCrawlClock(app, () => (minute += 60_000));
  const a = await seedAdmin(app, { username: "alice", email: "a@f.dev", password: "a-long-image-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  const repo = await createRepo(app, a.value, { name: "pics", visibility: "public" });
  if (!repo.ok) throw new Error("repo failed");
  const made = await commitToBranch(app, a.value, repo.value, {
    message: "pictures",
    files: [
      { path: "a.png", content: PNG },
      { path: "b.gif", content: GIF },
      { path: "c.webp", content: WEBP },
      { path: "d.svg", content: SVG },
    ],
  });
  if (!made.ok) throw new Error("commit failed");
});

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const page = async (path: string, query = ""): Promise<string> =>
  (await (await fetch(`${servers.url}/alice/pics/blob/main/${path}${query}`)).text()).replace(/\s+/g, " ");

describe("image blob pages", () => {
  for (const [file, format] of [["a.png", "PNG"], ["b.gif", "GIF"], ["c.webp", "WEBP"], ["d.svg", "SVG"]]) {
    test(`${file} is an <img> at the media route with a dimension slot`, async () => {
      const html = await page(file!);
      expect(html).toContain(`src="/alice/pics/media/main/${file}"`);
      expect(html).toContain("data-img-dim");
      expect(html).toContain(`<span>${format}</span>`);
      expect(html).toContain('href="/alice/pics/blob/main/' + file + '?view=source"');
      expect(html).toContain("?download=1");
    });
  }

  test("an SVG is never inlined", async () => {
    const html = await page("d.svg");
    expect(html).not.toContain("UNIQUE-RECT");
    expect(html).not.toContain("alert(1)");
  });

  test("the source view stays", async () => {
    const html = await page("d.svg", "?view=source");
    expect(html).not.toContain("data-img-view");
  });

  test("zoom is a real button and the pane can be reached by keyboard", async () => {
    const html = await page("a.png");
    expect(html).toMatch(/<button[^>]*type="button"[^>]*imgview-zoom[^>]*aria-pressed="false"/);
    expect(html).toMatch(/<button[^>]*class="btn js-only"/);
    expect(html).toMatch(/data-img-pane tabindex="0" role="region" aria-label="Image a\.png/);
  });

  test("a PNG's header size reserves the box before the bytes arrive", async () => {
    const html = await page("a.png");
    expect(html).toContain('width="640" height="480"');
    expect(await page("c.webp")).not.toContain('width=""');
  });

  test("the image cap decides: over it no <img>, under it one", () => {
    const draw = (size: number): string =>
      renderBlob({ base: "/alice/pics", kind: "local", caps: { write: false }, facts: { name: "pics" } } as unknown as RepoScope, {
        refs: { branches: ["main"], tags: [] } as RefSet,
        ref: "main",
        path: "a.png",
        blob: { kind: "text" as const, body: PNG, size, oid: "0".repeat(40) } as never,
      }).text;
    expect(draw(RENDER_CAP.image)).toContain("data-img-view");
    expect(draw(RENDER_CAP.image + 1)).not.toContain("data-img-view");
  });

});

/** `imageViewJs` run against a small fake of the DOM it touches. */
describe("the image view's script", () => {
  type Fn = (e: Record<string, unknown>) => void;
  const make = () => {
    const on: Record<string, Fn[]> = {};
    const slot = { textContent: "" };
    const pane = { cls: new Set<string>(), scrollLeft: 0, scrollTop: 0, classList: { toggle: (c: string) => (pane.cls.has(c) ? (pane.cls.delete(c), false) : (pane.cls.add(c), true)) } } as Record<string, any>;
    const button = { attrs: { "aria-pressed": "false" } as Record<string, string>, textContent: "Actual size", setAttribute: (k: string, v: string) => { button.attrs[k] = v; } } as Record<string, any>;
    const root = { querySelector: (q: string) => ({ "[data-img-dim]": slot, ".imgview-zoom": button, "[data-img-pane]": pane })[q] };
    const img = { naturalWidth: 640, naturalHeight: 480, complete: false, matches: () => true } as Record<string, any>;
    Object.assign(img, { closest: (q: string) => ({ ".imgview": root, "img[data-img-view]": img, "[data-img-pane]": pane, "[data-img-pane].is-actual": pane.cls.has("is-actual") ? pane : null })[q] ?? null });
    Object.assign(pane, { closest: (q: string) => (q === ".imgview" ? root : null) });
    Object.assign(button, { closest: (q: string) => ({ ".imgview": root, ".imgview-zoom": button })[q] ?? null });
    const doc = { addEventListener: (t: string, f: Fn) => void (on[t] ??= []).push(f), querySelectorAll: () => [] };
    new Function("doc", imageViewJs)(doc);
    const fire = (t: string, e: Record<string, unknown>) => on[t]?.forEach((f) => f(e));
    return { fire, slot, pane, button, img };
  };

  test("a load writes the pixel size into the slot", () => {
    const v = make();
    v.fire("load", { target: v.img });
    expect(v.slot.textContent).toBe("640 \u00d7 480 px");
  });

  test("the button toggles actual size, aria-pressed and its label, and back", () => {
    const v = make();
    v.fire("click", { target: v.button });
    expect(v.pane.cls.has("is-actual")).toBe(true);
    expect(v.button.attrs["aria-pressed"]).toBe("true");
    expect(v.button.textContent).toBe("Fit");
    v.fire("click", { target: v.button });
    expect(v.pane.cls.has("is-actual")).toBe(false);
    expect(v.button.attrs["aria-pressed"]).toBe("false");
    expect(v.button.textContent).toBe("Actual size");
  });

  test("a drag past 3px does not toggle, and the click after release does", async () => {
    const v = make();
    v.fire("click", { target: v.img });
    expect(v.pane.cls.has("is-actual")).toBe(true);
    const mouse = { pointerType: "mouse", button: 0, target: v.img, clientX: 100, clientY: 100, preventDefault() {} };
    v.fire("pointerdown", mouse);
    v.fire("pointermove", { ...mouse, clientX: 90, clientY: 100 });
    expect(v.pane.scrollLeft).toBe(10);
    v.fire("pointerup", mouse);
    v.fire("click", { target: v.img });
    expect(v.pane.cls.has("is-actual")).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    v.fire("click", { target: v.img });
    expect(v.pane.cls.has("is-actual")).toBe(false);
  });
});
