import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { suspendAccount, unsuspendAccount } from "../src/actions/accounts.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

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
      trusted: true,
      username,
      email: `${username}@f.dev`,
      password: "a-good-passphrase",
      adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
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
    readerCookie = `forge_session=${createSession(app.db, rita.id).token}`;
    ownerCookie = `forge_session=${createSession(app.db, owner.id).token}`;
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
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
