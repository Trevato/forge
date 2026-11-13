/**
 * No page is covered by a closed overlay (#11831 item 3, #11854).
 *
 * Release 0.7.549 drew a closed palette `<dialog>` over every page on a
 * phone. This drives a real headless Chromium at 390×844 and 1280×800, signed
 * out and signed in, over the forge's own pages: with nothing opened, the
 * element at the centre of the screen is the page's content, never a dialog,
 * popover or large fixed layer. Then the palette is opened and closed with
 * its close button, and the page is back.
 *
 * Only dialogs, popovers and `position: fixed` layers are looked for: an absolute or sticky
 * full-page layer is not detected. The detector is proved by a positive control: with the
 * palette open it must report a dialog, so an empty list is not blindness.
 *
 * Not held here: Escape and tap-outside (a native dialog takes those from a
 * real key and pointer, which this CDP helper does not send; test/palette-dismiss
 * holds them in the client script), and the release-proof half (#11831 item 4).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { findChromium } from "../src/looks/capture.ts";
import { quietLogs } from "./helpers/globals.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";

quietLogs();

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined)
  console.log("SKIPPING: no chromium that starts on this machine, so the covered-page test cannot run");

/** `/search` is left out: it opens the palette as a sheet on purpose (data-palette-auto). */
const PAGES = ["/", "/login", "/explore", "/apps", "/changelog"];
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
];

/** What is on top at the centre of the screen, and whether it is an overlay. */
const COVER = `(() => {
  const vw = document.documentElement.clientWidth, vh = innerHeight;
  const top = document.elementFromPoint(vw / 2, vh / 2);
  const covers = [];
  for (let el = top; el; el = el.parentElement) {
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    const big = r.width * r.height > (vw * vh) / 4;
    const kind = el.tagName === "DIALOG" ? "dialog" : el.hasAttribute("popover") ? "popover"
      : cs.position === "fixed" && big && cs.visibility !== "hidden" ? "fixed layer" : "";
    if (kind) covers.push(kind + ":" + el.tagName.toLowerCase() + "." + String(el.className));
  }
  return { signedIn: !!document.querySelector('form[action="/logout"]'),
    top: top ? top.tagName.toLowerCase() + "." + String(top.className) : "none", covers };
})()`;

describe.skipIf(chromium === undefined)("no page is covered by a closed overlay", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie = { name: "", value: "" };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-cover-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const signup = await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({ username: "ada", email: "ada@forge.local", password: "a-long-web-passphrase" }),
      redirect: "manual",
    });
    // Split on the first "=" only: a value may carry "=" padding of its own.
    const pair = (signup.headers.get("set-cookie") ?? "").split(";")[0]!;
    const eq = pair.indexOf("=");
    cookie = { name: pair.slice(0, eq), value: pair.slice(eq + 1) };
    expect(cookie.name).not.toBe("");
    expect(cookie.value).not.toBe("");
  }, 20_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  for (const viewport of VIEWPORTS)
    for (const signedIn of [false, true])
      for (const path of PAGES)
        test(`${path} at ${viewport.width}×${viewport.height}, ${signedIn ? "signed in" : "signed out"}: nothing closed is on top`, async () => {
          const out = JSON.parse(
            await evaluateLoaded(chromium!, `${base}${path}`, viewport, signedIn ? [cookie] : [],
              `JSON.stringify(${COVER})`),
          ) as { signedIn: boolean; top: string; covers: string[] };
          // The cookie must really sign the page in (or out),
          // else half the matrix is one run twice.
          expect(out.signedIn).toBe(signedIn);
          expect(out.covers).toEqual([]);
        }, 20_000);

  for (const viewport of VIEWPORTS)
    test(`the palette at ${viewport.width}×${viewport.height}: opens, its close button closes it, the page is back`, async () => {
      const out = JSON.parse(
        await evaluateLoaded(chromium!, `${base}/`, viewport, [cookie], `(async () => {
          const dlg = document.querySelector("dialog.palette, dialog#palette");
          if (!dlg) return JSON.stringify({ missing: true });
          const boxBefore = getComputedStyle(dlg).display;
          const opener = document.querySelector("[data-palette]");
          opener.click();
          const opened = dlg.open;
          const whileOpen = ${COVER};
          const close = dlg.querySelector("[data-palette-close]");
          // Wide screens hide the close button (display:none): close through the dialog itself.
          if (close && getComputedStyle(close).display !== "none") close.click(); else dlg.close();
          return JSON.stringify({ opened, whileOpen, closed: !dlg.open, boxBefore, boxAfter: getComputedStyle(dlg).display, cover: ${COVER} });
        })()`),
      ) as {
        missing?: boolean; opened: boolean; closed: boolean; boxBefore: string; boxAfter: string;
        whileOpen: { covers: string[] }; cover: { covers: string[] };
      };
      expect(out.missing).toBeUndefined();
      // A closed dialog has no layout box: it is not drawn at all.
      expect(out.boxBefore).toBe("none");
      expect(out.opened).toBe(true);
      // Positive control: open, the detector sees a dialog on top.
      expect(out.whileOpen.covers.some((c) => c.startsWith("dialog:"))).toBe(true);
      expect(out.boxAfter).toBe("none");
      expect(out.closed).toBe(true);
      expect(out.cover.covers).toEqual([]);
    }, 20_000);
});
