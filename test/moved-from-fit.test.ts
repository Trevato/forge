/**
 * The repository page's "Moved from" line (#10156): an old path holding markup
 * is escaped, and a long old path wraps instead of widening a 390 px phone.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo, type Repo } from "../src/core/repos.ts";
import { transferRepo } from "../src/core/transfer.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { findChromium } from "../src/looks/capture.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";

const OLD = `<b>&"/${"n".repeat(200)}`;
let dir: string;
let app: App;
let servers: Servers;
let page: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-moved-fit-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string) => {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-long-moved-passphrase", adminIfFirst: username === "alice" });
    if (!u.ok) throw new Error(u.error);
    return u.value;
  };
  const alice = await mk("alice");
  const lab = await mk("lab");
  const made = await createRepo(app.db, app.reposRoot, { ownerId: alice.id, name: "demo", visibility: "public" });
  if (!made.ok) throw new Error(made.error);
  const moved = await transferRepo(app.db, app.reposRoot, made.value as Repo, lab, alice.id);
  if (!moved.ok) throw new Error(moved.error);
  app.db.query("UPDATE repo_transfer SET from_path = ?1 WHERE repo_id = ?2").run(OLD, made.value.id);
  page = await (await fetch(`${servers.url}/lab/demo`)).text();
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the moved-from line", () => {
  test("an old path holding markup is escaped in the line", () => {
    const line = page.match(/<p class="muted small moved-from">[\s\S]*?<\/p>/)?.[0] ?? "";
    expect(line).toContain("Moved from &lt;b&gt;&amp;&quot;/nnnn");
    expect(line).not.toContain("<b>");
    expect(page).not.toContain("<b>&");
  });

  test("the line is server-rendered, plain, and carries no inline style", () => {
    expect(page).toMatch(/<p class="muted small moved-from">Moved from /);
    expect(page).not.toMatch(/<p class="muted small moved-from"[^>]*style=/);
  });
});

/** Measured in a real Chromium at 390x844; skipped where none starts (the forge's check runs it). */
const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined) console.log("SKIPPING: no chromium that starts here, so the moved-from phone look is not measured");

describe.skipIf(chromium === undefined)("the moved-from line, measured at 390x844", () => {
  const measure = `(() => {
    const el = document.querySelector(".moved-from");
    const r = el ? el.getBoundingClientRect() : { right: -1, height: 0 };
    return JSON.stringify({
      scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
      right: Math.round(r.right), height: Math.round(r.height), lineHeight: parseFloat(getComputedStyle(el).lineHeight),
    });
  })()`;
  test("a long old path wraps: the page does not scroll sideways", async () => {
    const m = JSON.parse(await evaluateLoaded(chromium!, `${servers.url}/lab/demo`, { width: 390, height: 844 }, [], measure)) as { scrollWidth: number; innerWidth: number; right: number; height: number; lineHeight: number };
    console.log(`moved-from 390x844: ${JSON.stringify(m)}`);
    expect(m.right).toBeGreaterThan(0);
    expect(m.right).toBeLessThanOrEqual(m.innerWidth);
    expect(m.height).toBeGreaterThan(m.lineHeight * 1.5);
    expect(m.scrollWidth).toBeLessThanOrEqual(m.innerWidth);
  }, 30_000);
});
