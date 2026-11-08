/**
 * The first-login card (VISION §4, `web/pages/next-steps.ts`): three steps in
 * order, each reachable by the admin it is drawn for, the everyday step
 * reading done once the account exists, and never shown to a guest or to a
 * second account.
 */

import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { childDirOf, spawnForge } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { addCrew, createAgentRow } from "../src/core/agents.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { quietLogs } from "./helpers/globals.ts";
import { passkeyFields } from "./helpers/passkey.ts";

quietLogs();

const PASSWORD = "a-long-next-steps-card-passphrase";
const FORGE_JSON = JSON.stringify({
  app: { run: "bun run index.ts", health: "/" },
});
const CARD = "Your next steps";

describe("the next-steps card of a spawned forge", () => {
  let dir = "";
  let parent: App;
  let parentServers: Servers;
  let child: App;
  let servers: Servers;
  let owner = "";

  const url = (path: string) => `${servers.url}${path}`;
  const page = async (cookie: string, path = "/") =>
    (await (await fetch(url(path), { headers: { cookie } })).text()).replace(
      /\s+/g,
      " ",
    );
  const post = (cookie: string, path: string, form: Record<string, string>) =>
    fetch(url(path), {
      method: "POST",
      headers: { cookie, origin: servers.url },
      body: new URLSearchParams(form),
      redirect: "manual",
    });
  const steps = (html: string) => {
    const card = html.slice(html.indexOf(CARD));
    return {
      everyday: /data-step="everyday"[^>]*data-done="(yes|no)"/.exec(card)?.[1],
      apps: /data-step="apps"[^>]*data-done="(yes|no)"/.exec(card)?.[1],
      tell: /data-step="tell"[^>]*data-done="(yes|no)"/.exec(card)?.[1],
    };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-next-steps-card-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const made = await createUser(parent.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "a@x.test",
      password: PASSWORD,
      isAdmin: true,
    });
    if (!made.ok) throw new Error("user");
    const alice = made.value;
    const repo = await createRepo(parent, alice, { name: "bakery" });
    if (!repo.ok) throw new Error("repo");
    const c = await commitFiles(repoDir(parent.reposRoot, "alice", "bakery"), {
      branch: "main",
      message: "bakery",
      files: [
        { path: "forge.json", content: FORGE_JSON },
        {
          path: "index.ts",
          content: "Bun.serve({fetch(){return new Response('hi')}})\n",
        },
      ],
      author: { name: "a", email: "a@x.invalid" },
    });
    if (!c.ok) throw new Error("commit");
    const atlas = await createUser(parent.db, {
      origin: "seed",
      username: "atlas",
      email: "atlas@a.invalid",
      agent: true,
    });
    if (!atlas.ok) throw new Error("agent");
    createAgentRow(parent.db, {
      userId: atlas.value.id,
      brief: "plan",
      createdBy: alice.id,
    });
    addCrew(parent.db, repo.value.id, atlas.value.id, alice.id);
    seatAs(parent.db, repo.value.id, atlas.value.id, "planner");
    parentServers = await serve(parent);
    const spawned = await spawnForge(
      parent,
      alice,
      {
        name: "maria",
        org: "marias",
        apps: ["alice/bakery"],
        carryBriefs: true,
        carrySubscriptions: false,
        direction: "Run Maria's bakery.",
      },
      {
        catalog: [
          { ref: "alice/bakery", readable: true, bytes: 10, forgeJsonBytes: 0 },
        ],
        briefs: [{ agent: "atlas", text: "plan" }],
        subscriptions: [],
      },
      {
        placement: hostedPlacement({ host: "forge.test" }),
        request: new Request("https://forge.test/x", {
          method: "POST",
          headers: { origin: "https://forge.test" },
        }),
        url: new URL("https://forge.test/x"),
      },
    );
    if (!spawned.ok) throw new Error(JSON.stringify(spawned.error));
    child = createApp({
      dataDir: childDirOf(parent, spawned.value.bodyId),
      port: 0,
    });
    await firstBoot(child);
    servers = await serve(child);
    const link = spawned.value.claimUrl!;
    const token = link.split("/claim#")[1]!;
    const who = { token, username: "maria", email: "maria@bakery.test" };
    const claimed = await fetch(url("/claim"), {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({
        ...who,
        ...(await passkeyFields(servers.url, "/claim/options", who)),
      }),
      redirect: "manual",
    });
    if (claimed.status !== 303) throw new Error(`claim ${claimed.status}`);
    owner = (claimed.headers.get("set-cookie") ?? "").split(";")[0]!;
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    child.close();
    parentServers.stop();
    parent.close();
    await rm(dir, { recursive: true, force: true });
  });

  const cardOf = (html: string) => {
    const from = html.indexOf(`id="next-steps"`);
    return from < 0 ? "" : html.slice(from, html.indexOf("</section>", from) < 0 ? undefined : html.indexOf("</section>", from));
  };
  const keys = (html: string) =>
    [...cardOf(html).matchAll(/data-step="(\w+)"/g)].map((m) => m[1]);

  test("the admin's first home carries exactly three steps, in order, none done", async () => {
    const home = await page(owner);
    expect(keys(home)).toEqual(["everyday", "apps", "tell"]);
    expect(steps(home)).toEqual({ everyday: "no", apps: "no", tell: "no" });
    const titles = ["Make your everyday account", "Open your apps", "Tell the crew something"];
    const at = titles.map((t) => cardOf(home).indexOf(t));
    expect(at.every((n) => n >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  test("the steps are one plain section, not boxed in cards", async () => {
    const card = cardOf(await page(owner));
    expect(card).not.toContain('class="card');
    expect(card).not.toContain("card-body");
    // A pending step's body is a block under its row, never an inline sibling of the title.
    expect(card).toMatch(/<\/ul>\s*<div class="step-body">/);
    // The first pending step, and only it, is the primary one.
    expect(card).toMatch(/data-step="everyday"[^>]*data-primary/);
    expect(card.match(/data-primary/g)?.length).toBe(1);
    expect(keys(await page(owner))).toEqual(["everyday", "apps", "tell"]);
  });

  test("each step's way in answers 200 for the admin", async () => {
    const home = await page(owner);
    const card = cardOf(home);
    // Open your apps: the app links in the card.
    const apps = [...card.matchAll(/href="(\/[^"#]+)"/g)].map((m) => m[1]!).filter((h) => h.startsWith("/marias/"));
    expect(apps).toContain("/marias/bakery");
    // Tell the crew: the card points at the composer, which must be on the page.
    expect(card).toContain('href="#composer"');
    expect(home).toContain('id="composer"');
    // Make your everyday account: the form lives in the card, which posts to a route only (no GET page); settings answers.
    expect(card).toContain('action="/settings/everyday"');
    const paths = [...new Set([...apps, "/settings"])];
    for (const p of paths) {
      const res = await fetch(url(p), { headers: { cookie: owner }, redirect: "manual" });
      expect([p, res.status]).toEqual([p, 200]);
    }
  });

  test("a guest never sees the card", async () => {
    const res = await fetch(url("/"), { redirect: "manual" });
    expect(res.status).toBeLessThan(400);
    expect(await res.text()).not.toContain(CARD);
  });

  test("a second account never sees the card", async () => {
    const other = await createUser(child.db, {
      origin: "seed",
      trusted: true,
      username: "second",
      email: "second@x.test",
      password: PASSWORD,
    });
    if (!other.ok) throw new Error("second");
    const session = createSession(child.db, other.value.id);
    const home = await page(`forge_session=${session.token}`);
    expect(home).not.toContain(CARD);
    expect(home).not.toContain('data-step="');
  });

  test("once the everyday account exists, its step reads done", async () => {
    const who = { username: "maria-me", email: "me@bakery.test" };
    const res = await post(owner, "/settings/everyday", {
      ...who,
      ...(await passkeyFields(servers.url, "/settings/everyday/options", who, { headers: { cookie: owner } })),
    });
    expect(res.status).toBe(303);
    const daily = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(steps(await page(owner)).everyday).toBe("yes");
    expect(steps(await page(daily)).everyday).toBe("yes");
    expect(keys(await page(owner))).toEqual(["everyday", "apps", "tell"]);
  });
});
