/**
 * Build pins: a writer marks a commit under refs/builds/<label>; the
 * builds page lists them.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { notePin, pinBuild } from "../src/actions/builds.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { promote } from "./helpers/members.ts";
import { listBuildPins } from "../src/git/builds.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { nextLabel } from "../src/web/pages/builds.ts";

describe("build pins", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let bob: User;
  let aliceCookie: string;
  let bobCookie: string;
  const oids: Record<string, string> = {};

  const signIn = async (username: string) =>
    (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({ username, password: "a-good-passphrase" }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
  const post = (path: string, cookie: string, body: Record<string, string>) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie, origin: base },
      body: new URLSearchParams(body),
      redirect: "manual",
    });
  const fresh = () => getRepo(app.db, "alice", "game")!;
  const pins = () => listBuildPins(repoDir(app.reposRoot, "alice", "game"));

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-pins-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    for (const name of ["alice", "bob"]) {
      const made = await createUser(app.db, { origin: "seed",
        trusted: true,
        username: name,
        email: `${name}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!made.ok) throw new Error(made.error);
      if (name === "alice") alice = made.value;
      else bob = made.value;
    }
    promote(app.db, bob);
    aliceCookie = await signIn("alice");
    bobCookie = await signIn("bob");
    const made = await createRepo(app, alice, { name: "game", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    for (const [branch, message] of [
      ["main", "one"],
      ["main", "two"],
      ["idea", "idea a"],
      ["idea", "idea b"],
    ] as const) {
      const c = await commitToBranch(app, alice, fresh(), {
        branch,
        message,
        files: [{ path: `${message}.txt`, content: `${message}\n` }],
      });
      if (!c.ok) throw new Error(JSON.stringify(c.error));
      oids[message] = c.value.commitOid;
    }
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a writer pins a commit from the form; it is a ref with its note and source", async () => {
    const res = await post("/alice/game/builds", aliceCookie, {
      sha: oids.one!,
      label: "v1",
      note: "first playable",
      source: "branch main",
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/alice/game/builds");
    const [pin] = await pins();
    expect(pin?.label).toBe("v1");
    expect(pin?.oid).toBe(oids.one!);
    expect(pin?.note).toBe("first playable");
    expect(pin?.source).toBe("branch main");
    expect(pin?.pinnedBy).toBe("alice");
  });

  test("a reader cannot pin, and a stranger's form is refused", async () => {
    const res = await post("/alice/game/builds", bobCookie, { sha: oids.two!, label: "evil" });
    expect(res.status).toBe(404);
    const forged = await fetch(`${base}/alice/game/builds`, {
      method: "POST",
      headers: { cookie: aliceCookie, origin: "https://evil.test" },
      body: new URLSearchParams({ sha: oids.two!, label: "evil" }),
      redirect: "manual",
    });
    expect(forged.status).toBe(403);
    expect((await pins()).map((p) => p.label)).not.toContain("evil");
  });

  test("bad labels, unknown commits and taken labels are refused", async () => {
    for (const label of ["-x", "a/b", "a b", "x".repeat(41), "refs..x"])
      expect(
        (await pinBuild(app, alice, fresh(), { label, oid: oids.two! })).ok,
      ).toBe(false);
    const missing = await pinBuild(app, alice, fresh(), { label: "ghost", oid: "f".repeat(40) });
    expect(missing.ok ? "" : missing.error).toBe("not_a_commit");
    const taken = await pinBuild(app, alice, fresh(), { label: "v1", oid: oids.two! });
    expect(taken.ok ? "" : taken.error).toBe("exists");
    const flag = await pinBuild(app, alice, fresh(), { label: "flag", oid: "--all" });
    expect(flag.ok).toBe(false);
  });

  test("the API lists the pins to a reader and refuses a write without a token", async () => {
    const listed = ((await (await fetch(`${base}/api/v1/repos/alice/game/builds`)).json()) as {
      items: { label: string }[];
    }).items;
    expect(listed.map((p) => p.label)).toContain("v1");
    const anon = await fetch(`${base}/api/v1/repos/alice/game/builds`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "api1", sha: oids.two! }),
    });
    expect(anon.status).toBe(401);
    expect((await pins()).map((p) => p.label)).not.toContain("api1");
  });

  test("the offered label steps on from the newest", () => {
    const pin = (label: string) =>
      ({ label, oid: "", note: "", parent: undefined, source: "", pinnedBy: "", pinnedAt: "" }) as const;
    expect(nextLabel([])).toBe("v1");
    expect(nextLabel([pin("2a")])).toBe("2b");
    expect(nextLabel([pin("v3")])).toBe("v4");
    expect(nextLabel([pin("demo")])).toBe("demo-2");
  });
});

describe("build pins pages and notes", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let cookie: string;
  let oid: string;
  const post = (path: string, body: Record<string, string>, origin = servers.url) =>
    fetch(`${servers.url}${path}`, { method: "POST", headers: { cookie, origin }, body: new URLSearchParams(body), redirect: "manual" });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-pins2-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const res = await fetch(`${servers.url}/signin`, { method: "POST", body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }), redirect: "manual" });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const repo = await createRepo(app, alice, { name: "game", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    const c = await commitToBranch(app, alice, getRepo(app.db, "alice", "game")!, { branch: "main", message: "one", files: [{ path: "a.txt", content: "a\n" }] });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    oid = c.value.commitOid;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the form is offered to a writer, the list shows the pin, the branches page links both", async () => {
    const form = await (await fetch(`${servers.url}/alice/game/builds/new?sha=${oid}`, { headers: { cookie } })).text();
    expect(form).toContain('name="label"');
    expect(form).toContain(`value="${oid}"`);
    expect(await (await fetch(`${servers.url}/alice/game/builds/new`)).text()).not.toContain('name="label"');
    expect((await post("/alice/game/builds", { sha: oid, label: "v1", note: "<b>first</b>" })).status).toBe(303);
    const list = await (await fetch(`${servers.url}/alice/game/builds`, { headers: { cookie } })).text();
    expect(list).toContain(">v1<");
    expect(list).toContain("&lt;b&gt;first&lt;/b&gt;");
    expect(list).not.toContain("<b>first</b>");
    const branches = await (await fetch(`${servers.url}/alice/game/branches`, { headers: { cookie } })).text();
    expect(branches).toContain("/alice/game/builds/new?sha=");
    expect(branches).toContain("/alice/game/builds");
  });

  test("a taken label is flashed back, not pinned twice", async () => {
    const again = await post("/alice/game/builds", { sha: oid, label: "v1" });
    expect(again.status).toBe(303);
    expect(again.headers.get("location")).toContain("/builds/new");
    expect((await listBuildPins(repoDir(app.reposRoot, "alice", "game"))).length).toBe(1);
  });

  test("a note is appended through the API, and copied once into the intent doc", async () => {
    const intent = join(dataDir, "intent.md");
    await Bun.write(intent, "# Intent\n");
    const noted = await notePin(
      { ...app, config: { ...app.config, notesIntent: intent } } as App,
      alice,
      getRepo(app.db, "alice", "game")!,
      "v1",
      { notes: "It plays." },
    );
    expect(noted.ok).toBe(true);
    const doc = await Bun.file(intent).text();
    expect(doc).toContain("## Iterator notes");
    expect(doc).toContain("It plays.");
    const pin = (await listBuildPins(repoDir(app.reposRoot, "alice", "game")))[0];
    expect(pin?.label).toBe("v1");
  });

  test("an agent cannot pin or note, even holding write access", async () => {
    const repo = getRepo(app.db, "alice", "game")!;
    const pins = () => listBuildPins(repoDir(app.reposRoot, "alice", "game"));
    const agent = { ...alice, kind: "agent" } as User;
    const pinned = await pinBuild(app, agent, repo, { label: "by-agent", oid: (await pins())[0]!.oid });
    expect(pinned).toEqual({ ok: false, error: "forbidden" });
    const noted = await notePin(app, agent, repo, (await pins())[0]!.label, { notes: "hi" });
    expect(noted).toEqual({ ok: false, error: "forbidden" });
  });

  test("a note cannot open a comment or a heading in the intent doc", async () => {
    const intent = join(dataDir, "intent-inject.md");
    await Bun.write(intent, "# Intent\n");
    const repo = getRepo(app.db, "alice", "game")!;
    const label = (await listBuildPins(repoDir(app.reposRoot, "alice", "game")))[0]!.label;
    const noted = await notePin({ ...app, config: { ...app.config, notesIntent: intent } } as App, alice, repo, label, {
      notes: "--> # Heading <!-- x\n# second\nmore",
    });
    expect(noted.ok).toBe(true);
    const doc = await Bun.file(intent).text();
    const line = doc.split("\n").find((l) => l.startsWith("- "))!;
    expect(line.match(/-->/g)?.length).toBe(1);
    expect(line.match(/<!--/g)?.length).toBe(1);
    expect(doc).not.toMatch(/^\s*#(?! Intent)(?!# Iterator notes)/m);
  });

  test("deleting a pin removes the ref and the list forgets it; a stranger's form is refused", async () => {
    expect((await post("/alice/game/builds/v1/delete", {}, "https://evil.test")).status).toBe(403);
    expect((await listBuildPins(repoDir(app.reposRoot, "alice", "game"))).length).toBe(1);
    expect((await post("/alice/game/builds/v1/delete", {})).status).toBe(303);
    expect(await listBuildPins(repoDir(app.reposRoot, "alice", "game"))).toEqual([]);
  });
});
