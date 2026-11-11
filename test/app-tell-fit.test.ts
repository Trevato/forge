/** An app's page, with the tell field showing, does not scroll sideways at 390 px or desk (#10075). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createSession } from "../src/core/sessions.ts";
import { findChromium } from "../src/looks/capture.ts";
import { PREVIEW_APP_PAGE } from "../src/spawn/preview-looks.ts";
import { previewAdmin, seedPreview } from "../src/spawn/preview-seed.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";

let dir: string;
let app: App;
let servers: Servers;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-app-tell-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  const seeded = await seedPreview(app, { FORGE_APP_ENV: "preview" });
  if (!seeded.ok) throw new Error(seeded.error);
  servers = await serve(app);
}, 30_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("the owner's app page, server-rendered, carries the tell field the looks picture", async () => {
  const cookie = `forge_session=${createSession(app.db, previewAdmin(app)!.id).token}`;
  const res = await fetch(`${servers.url}${PREVIEW_APP_PAGE}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toMatch(/<form class="bar tell-box"[^>]*action="[^"]*\/tell"/);
  expect(html).toContain('id="tell"');
  // A stranger is not shown it.
  const stranger = await (await fetch(`${servers.url}${PREVIEW_APP_PAGE}`)).text();
  expect(stranger).not.toContain('id="tell"');
});

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
// The agent sandbox sets FORGE_TEST_SOCKET and has no browser; the forge's check does not, and there a missing Chromium fails rather than leaving the fit unmeasured.
const sandboxed = process.env["FORGE_TEST_SOCKET"] !== undefined;
if (chromium === undefined) {
  if (sandboxed) console.log("SKIPPING: no chromium that starts in this sandbox, so the app page's phone look is not measured");
  else test("a chromium starts, so the app page's fit is measured", () => { throw new Error("no chromium starts here: the tell field's fit at 390 px cannot be measured"); });
}

describe.skipIf(chromium === undefined)("an app's page with the tell field, measured", () => {
  const measure = `(() => {
    const vw = document.documentElement.clientWidth;
    const box = document.querySelector("form.tell-box");
    const r = box ? box.getBoundingClientRect() : null;
    return JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: vw, tell: box !== null && !!document.querySelector("#tell") && !!box.querySelector("button"), inside: r !== null && r.left >= 0 && r.right <= vw + 1, rect: r && { left: r.left, right: r.right, width: r.width } });
  })()`;
  const look = async (width: number, height: number) => {
    const cookies = [{ name: "forge_session", value: createSession(app.db, previewAdmin(app)!.id).token }];
    return JSON.parse(await evaluateLoaded(chromium!, `${servers.url}${PREVIEW_APP_PAGE}`, { width, height }, cookies, measure)) as { scrollWidth: number; viewportWidth: number; tell: boolean; inside: boolean; rect: unknown };
  };
  for (const [name, w, h] of [["phone, 390x844", 390, 844], ["desk, 1280x800", 1280, 800]] as const)
    test(`${name}: the tell field shows and the page does not scroll sideways`, async () => {
      const m = await look(w, h);
      console.log(`app page look ${name}: ${JSON.stringify(m)}`);
      expect(m.tell).toBe(true);
      expect(m.inside).toBe(true);
      expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
    }, 30_000);
});
