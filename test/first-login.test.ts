/**
 * The first login to a spawned forge (#600): the person who claims it lands
 * on a home that shows their crew at work and one card with three next
 * steps — make your everyday account, open your apps, tell the crew
 * something — each ticking itself done, the card gone once all are. Only
 * on a spawned forge, only for its owner (or their everyday account); the
 * same three steps over the MCP.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { childDirOf, spawnForge } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { addCrew, createAgentRow, setCrewRole } from "../src/core/agents.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-first-login-passphrase";
const FORGE_JSON = JSON.stringify({
  app: { run: "bun run index.ts", health: "/" },
});
const CARD = "Your next steps";

describe("the first login to a spawned forge", () => {
  let dir = "";
  let parent: App;
  let parentServers: Servers;
  let child: App;
  let servers: Servers;
  let owner = "";
  let daily = "";

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
    dir = await mkdtemp(join(tmpdir(), "forge-first-login-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const made = await createUser(parent.db, {
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
    setCrewRole(parent.db, repo.value.id, atlas.value.id, "planner");
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
    const token = link.includes("#")
      ? link.split("#")[1]!
      : link.split("/claim/")[1]!;
    const claimed = await fetch(url(`/claim/${token}`), {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({
        username: "maria",
        email: "maria@bakery.test",
        password: PASSWORD,
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

  test("a forge that was not spawned shows no next-steps card, even to its admin", async () => {
    const res = await fetch(`${parentServers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: PASSWORD }),
      redirect: "manual",
    });
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const home = await (
      await fetch(`${parentServers.url}/`, { headers: { cookie } })
    ).text();
    expect(home).not.toContain(CARD);
  });

  test("a plain reader of the child sees no next-steps card", async () => {
    const reader = await createUser(child.db, {
      trusted: true,
      username: "reader",
      email: "r@x.test",
      password: PASSWORD,
    });
    if (!reader.ok) throw new Error("reader");
    const session = createSession(child.db, reader.value.id);
    expect(await page(`forge_session=${session.token}`)).not.toContain(CARD);
  });

  test("after the claim, the home shows the crew at work and one card with three steps, none done", async () => {
    const home = await page(owner);
    expect(home).toContain(CARD);
    expect(home).toContain("Make your everyday account");
    expect(home).toContain("Open your apps");
    expect(home).toContain("Tell the crew something");
    expect(steps(home)).toEqual({ everyday: "no", apps: "no", tell: "no" });
    // One card for the everyday account, not two: the steps card carries it.
    expect(home.split("Make your everyday account").length - 1).toBe(1);
    // The crew at work: the planner on the direction it was given.
    expect(home).toContain("atlas");
    expect(home).toContain("Run Maria");
    // Each app with its way in.
    expect(home).toContain('href="/marias/bakery"');
  });

  test("telling the crew something ticks the third step", async () => {
    const told = await post(owner, "/marias/bakery/tell", {
      text: "Add a weekly menu page.",
    });
    expect(told.status).toBeLessThan(400);
    expect(steps(await page(owner)).tell).toBe("yes");
  });

  test("opening an app ticks the second step", async () => {
    await page(owner, "/marias/bakery");
    expect(steps(await page(owner)).apps).toBe("yes");
  });

  test("making the everyday account ticks the first, and its home keeps the card until all are done", async () => {
    const res = await post(owner, "/settings/everyday", {
      username: "maria-me",
      email: "me@bakery.test",
      password: PASSWORD,
    });
    expect(res.status).toBe(303);
    daily = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(getUserByName(child.db, "maria-me")).toBeDefined();
    // All three done: the card is gone for both accounts.
    expect(await page(daily)).not.toContain(CARD);
    expect(await page(owner)).not.toContain(CARD);
  });

  test("the MCP `next_steps` tool answers the same three steps and their state", async () => {
    const maria = getUserByName(child.db, "maria")!;
    const token = createToken(child.db, maria.id, "ro", "ro").token;
    const res = await fetch(url("/mcp"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "next_steps", arguments: {} },
      }),
    });
    const body = (await res.json()) as any;
    const value = JSON.parse(body.result.content[0].text);
    expect(
      value.steps.map((s: { key: string; done: boolean }) => [s.key, s.done]),
    ).toEqual([
      ["everyday", true],
      ["apps", true],
      ["tell", true],
    ]);
  });
});
