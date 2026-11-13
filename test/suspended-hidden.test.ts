import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { suspendAccount, unsuspendAccount } from "../src/actions/accounts.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { resolveAppHostname } from "../src/apps/proxy.ts";
import { setFront } from "../src/actions/front.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { getRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

// A suspended account's repositories are kept, and hidden: a stranger and
// a signed-in reader find them in no list, page or route; the forge's owner
// still can; restoring the account brings them back as they were.
describe("a suspended account's repositories leave every list", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let owner: User;
  let sam: User;
  let rita: User;
  let readerCookie: string;
  let ownerCookie: string;

  const person = async (username: string, adminIfFirst = false) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@f.dev`,
      password: "a-good-passphrase",
      adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
    promote(app.db, made.value);
    return made.value;
  };
  const get = (path: string, cookie?: string, mode?: "dev") => {
    const jar = [cookie, mode && `forge_mode=${mode}`].filter(Boolean);
    return fetch(`${base}${path}`, {
      headers: jar.length === 0 ? {} : { cookie: jar.join("; ") },
      redirect: "manual",
    });
  };
  const text = async (path: string, cookie?: string) =>
    (await get(path, cookie)).text();
  let ritaToken = "";
  /** An MCP tool's answer for rita: its value, or its error text. */
  const tool = async (name: string, args: unknown) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${ritaToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    const said = body.result.content[0]!.text;
    return body.result.isError === true ? { error: said } : { value: said };
  };

  /** Every place a reader could find sam's repositories, as the reader sees it. */
  const sightings = async (cookie?: string): Promise<string[]> => {
    const seen: string[] = [];
    const look = async (
      where: string,
      path: string,
      needle = "sam/tools",
      mode?: "dev",
    ) => {
      const res = await get(path, cookie, mode);
      const body = await res.text();
      if (res.status === 200 && body.includes(needle)) seen.push(where);
    };
    await look("explore", "/explore");
    await look("search page", "/search?q=tools");
    await look("search api", "/api/v1/search?q=tools", "tools");
    await look("repo list api", "/api/v1/repos", "tools");
    await look("owner page", "/sam", "tools");
    await look("owner api", "/api/v1/users/sam", '"sam"');
    await look("owner repos api", "/api/v1/users/sam/repos", "tools");
    await look("repo page", "/sam/tools", "tools");
    await look("repo api", "/api/v1/repos/sam/tools", "tools");
    await look("git", "/sam/tools.git/info/refs?service=git-upload-pack", "service=git-upload-pack");
    // The command palette's index rides on every page (#831's first find).
    await look("palette", "/alice/base", '"t":"sam/tools"', "dev");
    await look("fork tree", "/alice/base/forks", "sam/");
    await look("fork api", "/api/v1/repos/alice/base/forks", '"sam"');
    await look("manifest", "/api/v1/here?path=/sam/tools", "tools");
    await look("llms.txt", "/llms.txt");
    await look("activity", "/", "sam/tools", "dev");
    return seen;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-suspended-hidden-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    owner = await person("olive", true);
    const alice = await person("alice");
    sam = await person("sam");
    rita = await person("rita");
    for (const [who, name] of [
      [alice, "base"],
      [sam, "tools"],
    ] as const) {
      const made = await createRepo(app, who, { name, visibility: "public" });
      if (!made.ok) throw new Error(String(made.error));
    }
    const samToken = createToken(app.db, sam.id, "t", "rw").token;
    const forked = await fetch(`${base}/api/v1/repos/alice/base/forks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${samToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "base-mine" }),
    });
    if (forked.status !== 201 && forked.status !== 202)
      throw new Error(`fork: ${forked.status} ${await forked.text()}`);
    // sam's repository has a commit, is an app with a public host, and rita
    // has forked it.
    const committed = await commitToBranch(app, sam, getRepo(app.db, "sam", "tools")!, {
      message: "Start",
      files: [{ path: "README.md", content: "hello\n" }],
    });
    if (!committed.ok) throw new Error(String(committed.error));
    expect(
      createAppRecord(app.db, {
        repoId: getRepo(app.db, "sam", "tools")!.id,
        slug: "samtools",
        access: "public",
      }).ok,
    ).toBe(true);
    ritaToken = createToken(app.db, rita.id, "t", "rw").token;
    const ritaFork = await fetch(`${base}/api/v1/repos/sam/tools/forks`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ritaToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "mine" }),
    });
    if (ritaFork.status !== 201 && ritaFork.status !== 202)
      throw new Error(`fork: ${ritaFork.status} ${await ritaFork.text()}`);
    // The door and the signed-out palette show the owner's apps and pins (#11902):
    // pin sam's repository so a stranger's sighting of it is the door's, and
    // suspension must remove it from there too.
    const pinned = setFront(app, owner, { pinned: ["sam/tools"], hidden: [] });
    if (!pinned.ok) throw new Error(JSON.stringify(pinned.error));
    readerCookie = `forge_session=${createSession(app.db, rita.id).token}`;
    ownerCookie = `forge_session=${createSession(app.db, owner.id).token}`;
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("before: the MCP's converge follows the parent", async () => {
    const answer = await tool("converge", { repo: "rita/mine" });
    expect(answer.error ?? "").not.toContain("not_a_fork");
  });

  test("before: the app answers at its host, and the fork proposes to its parent", async () => {
    const target = resolveAppHostname(app, "apps.test", "samtools.apps.test");
    expect(typeof target).toBe("object");
    expect(await text("/rita/mine/pulls/new", readerCookie)).toContain(
      'name="baseRepo" value="parent"',
    );
  });

  test("before: a stranger and a reader find them", async () => {
    // Every surface the suspended case checks finds them first (explore
    // lists only repositories with something in them, so it is not here).
    const everywhere = [
      "palette", "search page", "search api", "repo list api", "owner page", "owner api",
      "owner repos api", "repo page", "repo api", "git", "fork tree",
      "fork api", "manifest", "llms.txt", "activity",
    ];
    const stranger = await sightings();
    const reader = await sightings(readerCookie);
    for (const where of everywhere) {
      expect(stranger).toContain(where);
      expect(reader).toContain(where);
    }
  });

  test("suspended: a stranger and a reader find them nowhere", async () => {
    expect((await suspendAccount(app, owner, "sam")).ok).toBe(true);
    expect(await sightings()).toEqual([]);
    expect(await sightings(readerCookie)).toEqual([]);
    // Gone means the forge's one 404, not a page that says why.
    expect((await get("/sam/tools")).status).toBe(404);
    expect((await get("/sam")).status).toBe(404);
    expect((await get("/api/v1/repos/sam/tools")).status).toBe(404);
  });

  test("suspended: the app's host is a name nobody holds, and a fork's pages no longer read its parent", () => {
    expect(resolveAppHostname(app, "apps.test", "samtools.apps.test")).toBe(
      "unknown",
    );
  });

  test("suspended: the MCP's converge finds no parent to follow", async () => {
    const answer = await tool("converge", { repo: "rita/mine" });
    expect(answer.error ?? "").toContain("not_a_fork");
  });

  test("suspended: the fork's new-pull page proposes within itself, not to the hidden parent", async () => {
    const page = await text("/rita/mine/pulls/new", readerCookie);
    expect(page).not.toContain('name="baseRepo" value="parent"');
    expect(page).not.toContain("/sam/tools");
  });

  test("the forge's owner still finds them, to look and to restore", async () => {
    expect((await get("/sam/tools", ownerCookie)).status).toBe(200);
    expect(await text("/sam", ownerCookie)).toContain("tools");
  });

  test("restored: everything is back as it was", async () => {
    expect(unsuspendAccount(app, owner, "sam").ok).toBe(true);
    const stranger = await sightings();
    expect(stranger).toContain("repo page");
    expect(stranger).toContain("search api");
    expect(stranger).toContain("git");
  });
});
