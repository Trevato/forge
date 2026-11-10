/**
 * Every new forge comes with its own source (#10989): `<org>/forge`, named as
 * its `forgeRepo`, upstream wired to the parent's code; existing children get
 * it by an idempotent backfill that leaves a person's own repo alone.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { childDirOf, spawnForge } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { addCrew, createAgentRow, listCrewRoles } from "../src/core/agents.ts";
import { getOrg } from "../src/core/orgs.ts";
import { createRepo as createRepoCore, getRepo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { forgeLinkOf } from "../src/spawn/chain.ts";
import { backfillForgeCode } from "../src/spawn/forge_code.ts";
import { backfillChildren } from "../src/spawn/forge_code_backfill.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { setForgeSource, storedForgeSource } from "../src/settings/forge_source.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const source = { catalog: [], briefs: [], subscriptions: [] };
const spawn = (app: App, owner: User, name: string) =>
  spawnForge(
    app,
    owner,
    { name, org: name, apps: [], carryBriefs: false, carrySubscriptions: false },
    source,
    {
      placement: hostedPlacement({ host: "root.test" }),
      request: new Request("https://root.test/x", { method: "POST", headers: { origin: "https://root.test" } }),
      url: new URL("https://root.test/x"),
    },
  );

describe("a forge's own source", () => {
  let dir = "";
  let root: App;
  let alice: User;
  const open: App[] = [];
  let n = 0;

  /** A child born of a parent that named no code, so it has no `forge` repo: how the children before this began. */
  async function bornBare(name: string): Promise<{ child: App; childDir: string; parent: App }> {
    const parent = createApp({ dataDir: join(dir, `bare-${++n}`), url: `https://bare${n}.test`, port: 0 });
    open.push(parent);
    const u = await createUser(parent.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.test", isAdmin: true });
    if (!u.ok) throw new Error("user");
    const born = await spawn(parent, u.value, name);
    if (!born.ok) throw new Error(JSON.stringify(born.error));
    const childDir = childDirOf(parent, born.value.bodyId);
    const child = createApp({ dataDir: childDir, port: 0 });
    open.push(child);
    expect(getRepo(child.db, name, "forge")).toBeUndefined();
    return { child, childDir, parent };
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-own-"));
    root = createApp({ dataDir: dir, url: "https://root.test", port: 0, forgeRepo: "alice/forge-code" });
    const u = await createUser(root.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.test", isAdmin: true });
    if (!u.ok) throw new Error("user");
    alice = u.value;
    const made = await createRepo(root, alice, { name: "forge-code", visibility: "public" });
    if (!made.ok) throw new Error("repo");
    const c = await commitFiles(repoDir(root.reposRoot, "alice", "forge-code"), {
      branch: "main",
      message: "forge v1",
      files: [{ path: "README.md", content: "# forge\n" }],
      author: { name: "a", email: "a@x.invalid" },
    });
    if (!c.ok) throw new Error("commit");
  }, 120_000);

  afterAll(async () => {
    for (const a of open) a.close();
    root?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test("a spawned child has <admin>/forge, its forgeRepo setting and the parent as origin", async () => {
    const r = await spawn(root, alice, "kid");
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const child = createApp({ dataDir: childDirOf(root, r.value.bodyId), port: 0 });
    open.push(child);
    expect(getRepo(child.db, "kid", "forge")).toBeDefined();
    expect(storedForgeSource(child.db)).toBe("kid/forge");
    const link = await forgeLinkOf(child);
    expect(link?.repo).toBe("kid/forge");
    expect(link?.upstream).toBe("alice/forge-code");
  }, 240_000);

  test("backfill gives an existing child its source once", async () => {
    const { child, childDir } = await bornBare("old");
    expect((await backfillForgeCode(root, child, childDir)).ok).toBe(true);
    expect(getRepo(child.db, "old", "forge")).toBeDefined();
    expect(storedForgeSource(child.db)).toBe("old/forge");
    expect((await forgeLinkOf(child))?.upstream).toBe("alice/forge-code");
    const again = await backfillForgeCode(root, child, childDir);
    expect(again.ok && again.value).toBe("already");
  }, 240_000);

  test("a repo a person made under that name stays theirs", async () => {
    const { child, childDir } = await bornBare("mine");
    const theirs = await createRepoCore(child.db, child.reposRoot, { ownerId: getOrg(child.db, "mine")!.id, name: "forge", visibility: "private" });
    if (!theirs.ok) throw new Error("theirs");
    const left = await backfillForgeCode(root, child, childDir);
    expect(left.ok && left.value).toBe("left-alone");
    expect(storedForgeSource(child.db)).toBeUndefined();
    expect((await Bun.file(join(childDir, "parent.json")).json()).forgeCodeStarted).toBeUndefined();
  }, 240_000);

  test("a repo our own earlier run left unfinished is finished, not left alone", async () => {
    const { child, childDir } = await bornBare("half");
    // The run died after creating the repo and recording that it began: no refs, no forgeCode.
    const empty = await createRepoCore(child.db, child.reposRoot, { ownerId: getOrg(child.db, "half")!.id, name: "forge", visibility: "public" });
    if (!empty.ok) throw new Error("empty");
    const file = join(childDir, "parent.json");
    await Bun.write(file, JSON.stringify({ ...(await Bun.file(file).json()), forgeCodeStarted: "half/forge" }));
    const r = await backfillForgeCode(root, child, childDir);
    expect(r.ok && r.value).toBe("made");
    const doc = await Bun.file(file).json();
    expect(doc.forgeCode.repo).toBe("half/forge");
    expect(doc.forgeCodeStarted).toBeUndefined();
    const head = await runGit(["rev-parse", "--verify", "refs/heads/main"], { cwd: repoDir(child.reposRoot, "half", "forge") });
    expect(head.ok).toBe(true);
    expect(storedForgeSource(child.db)).toBe("half/forge");
  }, 240_000);

  test("the crew is seated on it with the role held on the child's other repos, and an earlier forgeRepo stands", async () => {
    const { child, childDir } = await bornBare("crewed");
    const mk = async (username: string) => {
      const a = await createUser(child.db, { username, email: `${username}@x.test`, agent: true, origin: "agent" });
      if (!a.ok) throw new Error("agent");
      createAgentRow(child.db, { userId: a.value.id, roles: ["builder", "planner"] });
      return a.value;
    };
    const pia = await mk("pia");
    await mk("bo");
    const other = await createRepoCore(child.db, child.reposRoot, { ownerId: getOrg(child.db, "crewed")!.id, name: "other", visibility: "private" });
    if (!other.ok) throw new Error("other");
    addCrew(child.db, other.value.id, pia.id, undefined, "builder");
    // An admin already chose a source: it stands.
    setForgeSource(child.db, "crewed/custom", pia.id);

    expect((await backfillForgeCode(root, child, childDir)).ok).toBe(true);
    const repo = getRepo(child.db, "crewed", "forge")!;
    const seats = new Map(listCrewRoles(child.db, repo.id).map((s) => [s.agent.user.username, s.role]));
    expect(seats.get("pia")).toBe("builder"); // copied, not the first role she declares (planner)
    expect(seats.get("bo")).toBe("planner"); // no seat elsewhere: the first role declared
    expect(storedForgeSource(child.db)).toBe("crewed/custom");
  }, 240_000);

  test("the backfill of all children is a recorded one-shot", async () => {
    const { parent, child } = await bornBare("later");
    expect(Object.keys(await backfillChildren(parent))).toEqual(["later"]);
    // Recorded as settled: the next boot opens nothing, and a child born afterwards is not swept in.
    expect(getRepo(child.db, "later", "forge")).toBeUndefined(); // the bare parent names no code
    expect(await Bun.file(join(parent.config.dataDir, "forge-code-backfill.json")).exists()).toBe(true);
    const u = getUserByName(parent.db, "alice")!;
    const born = await spawn(parent, u, "newer");
    if (!born.ok) throw new Error(JSON.stringify(born.error));
    expect(await backfillChildren(parent)).toEqual({});
  }, 240_000);
});
