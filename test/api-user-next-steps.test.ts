/**
 * GET /api/v1/user/next-steps (#7908): the owner of a spawned forge gets the
 * same three steps as MCP `next_steps`; anyone else, or an agent, gets [].
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
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { quietLogs } from "./helpers/globals.ts";
import { passkeyFields } from "./helpers/passkey.ts";

quietLogs();

const PASSWORD = "a-long-first-login-passphrase";
const FORGE_JSON = JSON.stringify({
  app: { run: "bun run index.ts", health: "/" },
});

describe("GET /api/v1/user/next-steps", () => {
  let dir = "";
  let parent: App;
  let parentServers: Servers;
  let child: App;
  let servers: Servers;
  let owner = "";

  const url = (path: string) => `${servers.url}${path}`;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-first-login-"));
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
  });
  afterAll(async () => {
    await servers.stop();
    await parentServers.stop();
    child.close();
    parent.close();
    await rm(dir, { recursive: true, force: true });
  });

  const get = (headers: Record<string, string>) =>
    fetch(url("/api/v1/user/next-steps"), { headers });
  const bearer = (id: string) => ({
    authorization: `Bearer ${createToken(child.db, id, "ro", "ro").token}`,
  });

  test("the owner gets three steps, the same as MCP next_steps", async () => {
    const maria = getUserByName(child.db, "maria")!;
    const res = await get(bearer(maria.id));
    expect(res.status).toBe(200);
    const rest = (await res.json()) as { steps: { key: string; done: boolean }[] };
    expect(rest.steps.map((s) => s.key)).toEqual(["everyday", "apps", "tell"]);
    const mcp = await fetch(url("/mcp"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...bearer(maria.id),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "next_steps", arguments: {} },
      }),
    });
    const body = (await mcp.json()) as any;
    expect(rest).toEqual(JSON.parse(body.result.content[0].text));
  });

  test("the owner's session works too", async () => {
    const res = await get({ cookie: owner });
    expect(((await res.json()) as any).steps).toHaveLength(3);
  });

  test("another account gets []", async () => {
    const made = await createUser(child.db, {
      origin: "seed",
      username: "stranger",
      email: "s@x.test",
      password: PASSWORD,
    });
    if (!made.ok) throw new Error("user");
    const res = await get(bearer(made.value.id));
    expect(await res.json()).toEqual({ steps: [] });
  });

  test("an agent's token gets [], never the owner's steps", async () => {
    const made = await createUser(child.db, {
      origin: "seed",
      username: "robot",
      email: "r@x.invalid",
      agent: true,
    });
    if (!made.ok) throw new Error("agent");
    const res = await get(bearer(made.value.id));
    expect(await res.json()).toEqual({ steps: [] });
  });

  test("anonymous is a 401", async () => {
    expect((await get({})).status).toBe(401);
  });
});
