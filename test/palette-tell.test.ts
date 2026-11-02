/**
 * The palette's last row, "Tell the crew: <what you typed>" (#5885): in a
 * real headless Chromium on a repository page, type a sentence, pick the
 * row, and the tell is in the forge with that page as where it was said.
 * Signed out, the row is not drawn. The refusals are the action's own words.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { findChromium } from "../src/looks/capture.ts";
import { chromiumRuns, evaluateLoaded } from "./helpers/chrome.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

const found = findChromium();
const chromium = found !== undefined && chromiumRuns(found) ? found : undefined;
if (chromium === undefined)
  console.log("SKIPPING: no chromium that starts on this machine, so the palette tell browser tests cannot run");

/** Open the palette, type `text`, and report the rows; with `pick`, choose the tell row. */
const drive = (text: string, pick: boolean): string => `(async () => { try {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const opener = document.querySelector("[data-palette]");
  if (!opener) return JSON.stringify({ error: "no palette button on " + location.href + ": " + document.title });
  opener.click();
  await wait(100);
  const dlg = document.getElementById("palette");
  const input = dlg.querySelector(".palette-input");
  input.value = ${JSON.stringify(text)};
  input.dispatchEvent(new Event("input"));
  await wait(100);
  const rows = [...dlg.querySelectorAll(".palette-item")];
  const last = rows[rows.length - 1];
  const tellRow = last && last.hasAttribute("data-tell") ? last.textContent : null;
  let toast = null;
  if (${pick} && last) {
    last.click();
    await wait(800);
    const t = document.querySelector(".toast[data-palette-tell]");
    toast = t ? { text: t.querySelector(".toast-body").textContent, link: t.querySelector("a")?.getAttribute("href") ?? null } : null;
  }
  return JSON.stringify({ tellRow, rows: rows.length, open: dlg.open, toast });
  } catch (e) { return JSON.stringify({ error: String(e && e.stack || e) }); }
})()`;

describe.skipIf(chromium === undefined)("the palette's tell row", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let cookies: { name: string; value: string }[] = [];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-palette-tell-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "keeper",
      email: "keeper@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    promote(app.db, made.value);
    cookies = [{ name: "forge_session", value: createSession(app.db, made.value.id).token }];
    const repo = await createRepo(app, made.value, { name: "garden", visibility: "public" });
    if (!repo.ok) throw new Error("repo");
    const seeded = await commitToBranch(app, made.value, repo.value, {
      message: "seed",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("on a repository page, typing a sentence and picking the last row tells the crew from that page", async () => {
    const said = "make the garden gate green";
    const out = JSON.parse(
      await evaluateLoaded(
        chromium!,
        `${servers.url}/keeper/garden`,
        { width: 1280, height: 800 },
        cookies,
        drive(said, true),
      ),
    );
    expect(out.error).toBeUndefined();
    expect(out.tellRow).toBe(`Tell the crew: ${said}`);
    expect(out.open).toBe(false);
    expect(out.toast.link).toMatch(/^\/keeper\/garden\/issues\/\d+$/);
    const issue = app.db
      .query("SELECT title, body FROM issue WHERE title LIKE ?1")
      .get(`%${said}%`) as { title: string; body: string } | null;
    expect(issue).not.toBeNull();
    expect(issue!.body).toContain("Told from [/keeper/garden](/keeper/garden)");
  }, 30_000);

  test("under three characters there is no tell row", async () => {
    const out = JSON.parse(
      await evaluateLoaded(chromium!, `${servers.url}/keeper/garden`, { width: 1280, height: 800 }, cookies, drive("ga", false)),
    );
    expect(out.error).toBeUndefined();
    expect(out.tellRow).toBeNull();
  }, 30_000);

  test("signed out, the row is not drawn and the page carries no tell target", async () => {
    const out = JSON.parse(
      await evaluateLoaded(chromium!, `${servers.url}/keeper/garden`, { width: 1280, height: 800 }, [], drive("make the garden gate green", false)),
    );
    expect(out.error).toBeUndefined();
    expect(out.tellRow).toBeNull();
    const html = await (await fetch(`${servers.url}/keeper/garden`)).text();
    expect(html).not.toContain('"tell":');
  }, 30_000);
});

describe("the tell the palette posts", () => {
  test("an empty tell answers in the action's own words, as JSON", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-palette-tell-"));
    const app = createApp({ dataDir, port: 0 });
    const servers = await serve(app);
    try {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: "keeper",
        email: "keeper@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!made.ok) throw new Error(made.error);
      promote(app.db, made.value);
      const cookie = `forge_session=${createSession(app.db, made.value.id).token}`;
      const res = await fetch(`${servers.url}/tell`, {
        method: "POST",
        headers: { cookie, accept: "application/json" },
        body: new URLSearchParams({ app: "forge", text: "  ", from: "/" }),
      });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error.length).toBeGreaterThan(0);
      const index = await (await fetch(`${servers.url}/`, { headers: { cookie } })).text();
      expect(index).toContain('"tell":{"app":"forge"}');
      // Without script there is still a door to the composer, signed in only.
      expect(index).toContain('href="/#composer"');
      expect(await (await fetch(`${servers.url}/explore`)).text()).not.toContain('href="/#composer"');
      // A forge page is not an owner's: it still answers with the forge as the target.
      const settings = await (await fetch(`${servers.url}/settings/origins`, { headers: { cookie } })).text();
      expect(settings).toContain('"tell":{"app":"forge"}');
    } finally {
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
