/**
 * A spawned child's apps (#712): at first boot each repository it was given
 * whose tip declares an app becomes one, once; after claiming, the home
 * shows them, never "No apps yet"; and while the crew has no model
 * credential, the home and the app page say so and where to add one.
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
import { getAppByRepo, listApps } from "../src/core/apps.ts";
import { getRepo } from "../src/core/repos.ts";
import {
  addSubscription,
  crewHasCredential,
} from "../src/core/subscriptions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { quietLogs } from "./helpers/globals.ts";
import { emailVerified } from "../src/core/verify.ts";
import { passkeyFields } from "./helpers/passkey.ts";

quietLogs();

const author = { name: "a", email: "a@x.invalid" };
const FORGE_JSON = JSON.stringify({
  app: { run: "bun run index.ts", health: "/" },
});

describe("a spawned child's apps", () => {
  let dir = "";
  let parent: App;
  let child: App;
  let servers: Servers;
  let cookie = "";

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-child-apps-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const made = await createUser(parent.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "a@x.invalid",
      isAdmin: true,
    });
    if (!made.ok) throw new Error("user");
    const alice = made.value;
    // One app (its forge.json says so) and one plain repository.
    for (const [name, files] of [
      [
        "bakery",
        [
          { path: "forge.json", content: FORGE_JSON },
          {
            path: "index.ts",
            content: "Bun.serve({fetch(){return new Response('hi')}})\n",
          },
        ],
      ],
      ["recipes", [{ path: "README.md", content: "# recipes\n" }]],
    ] as const) {
      // Public: so a stranger can open the app page, and must not see owner facts.
      const repo = await createRepo(parent, alice, { name, visibility: "public" });
      if (!repo.ok) throw new Error("repo");
      const c = await commitFiles(repoDir(parent.reposRoot, "alice", name), {
        branch: "main",
        message: name,
        files: [...files],
        author,
      });
      if (!c.ok) throw new Error("commit");
      if (name === "bakery") {
        const atlas = await createUser(parent.db, { origin: "seed", trusted: true,
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
      }
    }
    const spawned = await spawnForge(
      parent,
      alice,
      {
        name: "maria",
        org: "marias",
        apps: ["alice/bakery", "alice/recipes"],
        carryBriefs: true,
        carrySubscriptions: false,
        direction: "Run Maria's bakery.",
      },
      {
        catalog: [
          { ref: "alice/bakery", readable: true, bytes: 10, forgeJsonBytes: 0 },
          {
            ref: "alice/recipes",
            readable: true,
            bytes: 10,
            forgeJsonBytes: 0,
          },
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
    child = createApp({ dataDir: childDirOf(parent, spawned.value.bodyId), port: 0 });
    await firstBoot(child);
    servers = await serve(child);
    const token = spawned.value.claimUrl!.split("/claim#")[1]!;
    const who = { token, username: "maria", email: "maria@bakery.test" };
    const claimed = await fetch(`${servers.url}/claim`, {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({
        ...who,
        ...(await passkeyFields(servers.url, "/claim/options", who)),
      }),
      redirect: "manual",
    });
    expect(claimed.status).toBe(303);
    cookie = (claimed.headers.get("set-cookie") ?? "").split(";")[0]!;
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    child.close();
    parent.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("the repository whose tip declares an app is an app; the plain one is not", () => {
    expect(
      getAppByRepo(child.db, getRepo(child.db, "marias", "bakery")!.id),
    ).toBeDefined();
    expect(
      getAppByRepo(child.db, getRepo(child.db, "marias", "recipes")!.id),
    ).toBeUndefined();
  });

  test("a second boot registers nothing twice", async () => {
    const before = listApps(child.db).length;
    await firstBoot(child);
    expect(listApps(child.db).length).toBe(before);
  });

  test("after claiming, the home shows the app, and says the crew cannot start yet and where to add one", async () => {
    const home = (
      await (await fetch(`${servers.url}/`, { headers: { cookie } })).text()
    ).replace(/\s+/g, " ");
    expect(home).toContain("bakery");
    expect(home).not.toContain("No apps yet");
    expect(home).toContain("The crew cannot start work yet");
    expect(home).toContain('href="/settings/subscriptions"');
    const appPage = await (
      await fetch(`${servers.url}/marias/bakery`, { headers: { cookie } })
    ).text();
    expect(appPage).toContain("The crew cannot start work yet");
  });

  test("on the app page the key note is an owner fact: not for a stranger or a plain reader", async () => {
    const anonymous = await (await fetch(`${servers.url}/marias/bakery`)).text();
    expect(anonymous).toContain("bakery");
    expect(anonymous).not.toContain("The crew cannot start work yet");
    const reader = await createUser(child.db, { origin: "seed", trusted: true,
      username: "reader",
      email: "reader@x.test",
      password: "a-long-reader-passphrase",
    });
    if (!reader.ok) throw new Error("reader");
    const { createSession } = await import("../src/core/sessions.ts");
    const session = createSession(child.db, reader.value.id);
    const asReader = await (
      await fetch(`${servers.url}/marias/bakery`, {
        headers: { cookie: `forge_session=${session.token}` },
      })
    ).text();
    expect(asReader).toContain("bakery");
    expect(asReader).not.toContain("The crew cannot start work yet");
    // Nor on the home: there the note is for an admin or a writer of an app.
    const readerHome = await (
      await fetch(`${servers.url}/`, {
        headers: { cookie: `forge_session=${session.token}` },
      })
    ).text();
    expect(readerHome).not.toContain("The crew cannot start work yet");
  });

  test("first boot registers apps as the founder, an account with no verified email", () => {
    // The founder is the spawner's name only: a placeholder address and no
    // password. Registering the apps at first boot must not depend on a
    // check it can never pass (#710): the spawn vouches for the founder, so
    // its email is proven from the start.
    const founder = getUserByName(child.db, "alice")!;
    expect(founder.email.endsWith("@spawn.forge.invalid")).toBe(true);
    expect(emailVerified(child.db, founder.id)).toBe(true);
    expect(getAppByRepo(child.db, getRepo(child.db, "marias", "bakery")!.id)).toBeDefined();
  });

  test("the MCP `apps` tool lists the child's app", async () => {
    const maria = getUserByName(child.db, "maria")!;
    const ro = createToken(child.db, maria.id, "ro", "ro").token;
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${ro}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "apps", arguments: {} },
      }),
    });
    const text = ((await res.json()) as any).result.content[0].text as string;
    expect(text).toContain("marias/bakery");
  });

  test("a credential in the environment or a sealed account means the crew can run, and the note goes", async () => {
    expect(crewHasCredential(child.db, {})).toBe(false);
    expect(crewHasCredential(child.db, { ANTHROPIC_API_KEY: "sk-ant-x" })).toBe(
      true,
    );
    expect(
      crewHasCredential(child.db, {
        FORGE_CLAUDE_CONFIG_DIR: "/home/forge/.claude",
      }),
    ).toBe(true);
    const added = addSubscription(child.db, child.config.dataDir, {
      name: "maria-key",
      token: "sk-ant-api03-abcdefghijklmnop",
    });
    expect(added.ok).toBe(true);
    expect(crewHasCredential(child.db, {})).toBe(true);
    const home = await (
      await fetch(`${servers.url}/`, { headers: { cookie } })
    ).text();
    expect(home).not.toContain("The crew cannot start work yet");
  });
});
