/**
 * Private by default, and plain about it (#10391): a new repository, a new
 * app, a fork of a private one and the preview of a private app's pull each
 * start private, and the API, the MCP `here` tool and a visibility change all
 * say so in the same words (`audience { level, who, sentence }`). A stranger
 * asking about a private repository gets exactly what a missing one gets.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { newApp } from "../src/actions/apps.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { audienceFor, whoOf } from "../src/core/audience.ts";
import { createApp as createAppRecord, getAppByRepo } from "../src/core/apps.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("who can see it, said once, everywhere", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let aliceRw = "";
  let bobRw = "";
  let pull = 0;
  let id = 1;

  const here = async (token: string, url: string) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: id++,
        method: "tools/call",
        params: { name: "here", arguments: { url } },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };
  const api = (path: string, token: string, init: RequestInit = {}) =>
    fetch(`${servers.url}/api/v1${path}`, {
      ...init,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
      },
    });
  const appHost = (label: string) => `http://${label}.apps.test:${servers.port}/`;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-visibility-line-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: "apps.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
    });
    await runtime.start();
    await seedAdmin(app, { username: "root", email: "root@forge.local", password: "a-good-passphrase" });
    for (const name of ["alice", "bob"]) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: name,
        email: `${name}@forge.local`,
        password: "a-good-passphrase",
      });
      if (!made.ok) throw new Error(made.error);
      promote(app.db, made.value);
    }
    alice = getUserByName(app.db, "alice")!;
    aliceRw = tokenFor(app, "alice", "admin");
    bobRw = tokenFor(app, "bob", "rw");
  }, 30_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a new repository is private to its owner, and GET says so", async () => {
    const made = await createRepo(app, alice, { name: "notes" });
    if (!made.ok) throw new Error(String(made.error));
    expect(made.value.visibility).toBe("private");
    const body: any = await (await api("/repos/alice/notes", aliceRw)).json();
    expect(body.audience.who).toBe("owner");
    expect(body.audience.level).toBe("private");
    expect(body.audience).toEqual(audienceFor(app.db, made.value, alice));
  });

  test("a stranger asking about a private repository gets what a missing one gets", async () => {
    for (const token of [bobRw, ""]) {
      const hidden = await api("/repos/alice/notes", token);
      const missing = await api("/repos/alice/no-such-thing", token);
      expect(hidden.status).toBe(missing.status);
      expect(await hidden.text()).toBe(await missing.text());
    }
    const hidden = await here(bobRw, `${servers.url}/alice/notes`);
    const missing = await here(bobRw, `${servers.url}/alice/no-such-thing`);
    expect(hidden.error).toBeDefined();
    expect(hidden.error).toBe(missing.error);
  });

  test("the MCP here tool repeats the line on a repository page", async () => {
    const r = await here(aliceRw, `${servers.url}/alice/notes`);
    expect(r.value.here.audience).toEqual(
      audienceFor(app.db, getRepo(app.db, "alice", "notes")!, alice),
    );
  });

  test("a fork of a private repository is private, whatever is asked", async () => {
    const made = await forkRepo(app, alice, getRepo(app.db, "alice", "notes")!, "notes-copy", {
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    expect(made.value.visibility).toBe("private");
    expect(audienceFor(app.db, made.value, alice).who).toBe("owner");
  });

  test("a new app is private, and so is its repository", async () => {
    const made = await newApp(app, alice, { name: "vault" } as never);
    if (!made.ok) throw new Error(String(made.error));
    const repo = getRepo(app.db, "alice", "vault")!;
    expect(repo.visibility).toBe("private");
    expect(getAppByRepo(app.db, repo.id)!.access).toBe("private");
    const line = audienceFor(app.db, repo, alice);
    expect(line.who).toBe("owner");
    expect(line.level).toBe("private");
    expect(line.sentence).toStartWith("Private:");
    const owner = await here(aliceRw, appHost("vault"));
    expect(owner.value.audience).toEqual(line);
  });

  test("the preview of a private app's pull answers its owner with the line, and a stranger like nothing", async () => {
    const repo = getRepo(app.db, "alice", "vault")!;
    const committed = await commitToBranch(app, alice, repo, {
      branch: "change",
      base: repo.defaultBranch,
      message: "A change",
      files: [{ path: "CHANGE.md", content: "hi\n" }],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const opened = await openPull(app, alice, repo, {
      title: "A change",
      baseBranch: repo.defaultBranch,
      headBranch: "change",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    pull = opened.value.number;
    const owner = await here(aliceRw, appHost(`vault--${pull}`));
    expect(owner.value.environment).toBe(`pull-${pull}`);
    expect(owner.value.audience.who).toBe("owner");
    expect(owner.value.audience.level).toBe("private");
    expect(owner.value.audience.sentence).toStartWith("Private:");
    expect(owner.value.audience).toEqual(audienceFor(app.db, repo, alice));
    const stranger = await here(bobRw, appHost(`vault--${pull}`));
    const missing = await here(bobRw, appHost("nothing"));
    expect(stranger.error).toBeDefined();
    expect(stranger.error).toBe(missing.error);
  });

  test("a public app on a private repository tells its visitors nothing about who can read the code", async () => {
    const made = await createRepo(app, alice, { name: "shopfront" });
    if (!made.ok) throw new Error(String(made.error));
    expect(made.value.visibility).toBe("private");
    const record = createAppRecord(app.db, { repoId: made.value.id, slug: "shopfront", access: "public" });
    if (!record.ok) throw new Error(String(record.error));
    const visitor = await here(bobRw, appHost("shopfront"));
    expect(visitor.value).toBeDefined();
    expect(visitor.value.app).toBe("shopfront");
    expect("audience" in visitor.value).toBe(false);
    const owner = await here(aliceRw, appHost("shopfront"));
    expect(owner.value.audience).toEqual(audienceFor(app.db, made.value, alice));
  });

  test("changing visibility is a receipted action, and the line moves in the same answer", async () => {
    const opened = await api("/repos/alice/notes", aliceRw, {
      method: "PATCH",
      body: JSON.stringify({ visibility: "public" }),
    });
    expect(opened.status).toBe(200);
    const body: any = await opened.json();
    expect(body.visibility).toBe("public");
    expect(body.audience.who).toBe("anyone");
    expect(body.audience.sentence).toStartWith("Public: anyone can read this;");
    const receipt = app.db
      .query<{ payload: string }, [string]>(
        "SELECT payload FROM event WHERE kind = 'repo.settings_updated' AND repo_id = ?1",
      )
      .get(getRepo(app.db, "alice", "notes")!.id);
    expect(JSON.parse(receipt!.payload).changed.visibility).toEqual({ from: "private", to: "public" });
    // Now anyone may ask, and is told the same line.
    const seen: any = await (await api("/repos/alice/notes", bobRw)).json();
    expect(seen.audience.who).toBe("anyone");
    const closed: any = await (
      await api("/repos/alice/notes", aliceRw, {
        method: "PATCH",
        body: JSON.stringify({ visibility: "private" }),
      })
    ).json();
    expect(closed.audience.who).toBe("owner");
    expect(closed.audience.level).toBe("private");
  });
});

test("who reads as one word: the owner, an organization's members, or anyone", () => {
  expect(whoOf({ visibility: "private", ownerKind: "user" })).toBe("owner");
  expect(whoOf({ visibility: "private", ownerKind: "org" })).toBe("members");
  expect(whoOf({ visibility: "public", ownerKind: "user" })).toBe("anyone");
  expect(whoOf({ visibility: "public", ownerKind: "org" })).toBe("anyone");
});
