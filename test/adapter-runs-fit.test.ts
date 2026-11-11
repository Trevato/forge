/**
 * The app page's Adapter section with ten recorded runs, one failed with a long
 * reason, fits a 390 px phone (#10158). Where a Chromium starts, the page is
 * measured at 390x844; the seeded preview app carries the same runs for its look.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { createApp, type App } from "../src/app.ts";
import { createPullRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { getRepo } from "../src/core/repos.ts";
import { getUserByName, createUser } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { PREVIEW_APP_PAGE, PREVIEW_OWNER_LOOKS } from "../src/spawn/preview-looks.ts";
import { PREVIEW_LONG_REASON } from "../src/spawn/preview-seed.ts";
import { findChromium } from "../src/looks/capture.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";

const REASON = `<b>boom</b> ${"Z".repeat(190)}`;
let dir: string, app: App, servers: Servers, cookie: string, page: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-adapter-runs-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.dev", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  const u = getUserByName(app.db, "alice")!;
  const n = await newApp(app, u, { name: "hello", visibility: "public" } as never);
  if (!n.ok) throw new Error(String(n.error));
  const repo = getRepo(app.db, "alice", "hello")!;
  const appId = (app.db.query("SELECT id FROM app WHERE repo_id = ?1").get(repo.id) as { id: string }).id;
  const c = await commitFiles(repoDir(app.reposRoot, "alice", "hello"), {
    branch: repo.defaultBranch,
    message: "forge.json",
    files: [{ path: "forge.json", content: JSON.stringify({ run: "bun run src/server.ts", adapter: { schedule: { every: 900 } } }) }],
    author: { name: "T", email: "t@forge.test" },
  });
  if (!c.ok) throw new Error(JSON.stringify(c.error));
  for (let i = 0; i < 12; i++) {
    const failed = i === 5;
    createPullRun(app.db, { appId, state: failed ? "failed" : "ok", written: 3, skipped: 1, failed: 0, cursor: failed ? "" : `c${String(i)}`, durationMs: 5, reason: failed ? REASON : "", repeat: false });
  }
  cookie = `forge_session=${createSession(app.db, u.id).token}`;
  page = await (await fetch(`${servers.url}/alice/hello`, { headers: { cookie } })).text();
}, 60_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the Adapter section's runs", () => {
  test("ten runs are listed, the long reason escaped and in a wrapping row", () => {
    expect(page.match(/<li class="break">/g)?.length).toBe(10);
    expect(page).toContain("&lt;b&gt;boom&lt;/b&gt;");
    expect(page).not.toContain("<b>boom</b>");
    expect(page).toContain("Z".repeat(190));
  });

  test("the preview's seeded app and phone look carry the same case", () => {
    expect(PREVIEW_LONG_REASON.length).toBe(200);
    expect(PREVIEW_OWNER_LOOKS).toContainEqual({ page: PREVIEW_APP_PAGE, kind: "phone" });
  });
});

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts here, so the app page is not measured");

describe.skipIf(chromium === undefined)("measured at 390x844", () => {
  test("no sideways scroll", async () => {
    const measure = `(() => JSON.stringify({ scrollWidth: document.documentElement.scrollWidth, viewportWidth: document.documentElement.clientWidth, runs: document.querySelectorAll(".pull-runs li").length }))()`;
    const m = JSON.parse(await evaluateLoaded(chromium!, `${servers.url}/alice/hello`, { width: 390, height: 844 }, [{ name: "forge_session", value: cookie.split("=")[1]! }], measure));
    expect(m.runs).toBe(10);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.viewportWidth);
  }, 30_000);
});
