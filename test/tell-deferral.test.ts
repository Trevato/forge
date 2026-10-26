/** The batch skips the dependency graph only for issues on no edge (#6184): same words as the graph gives. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { addDependency, linkedIssueIds } from "../src/core/dependencies.ts";
import { createIssue, type Issue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { tellWord, tellWords } from "../src/web/studio/tell.ts";
import { servingHistory, type WordCtx } from "../src/web/studio/words.ts";
import { adminCookie } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("deferral in a batch of tells", () => {
  let dataDir = "";
  let app: App;
  let repo: Repo;
  let gate: Issue;
  let umbrella: Issue;
  let child: Issue;
  let loose: Issue;

  const ctx = (): WordCtx => ({
    db: app.db,
    dir: repoDir(app.reposRoot, repo.ownerName, repo.name),
    runtime: undefined,
    record: undefined,
    history: servingHistory(),
    viewer: undefined,
  });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tell-deferral-"));
    app = createApp({ dataDir, port: 0 });
    await adminCookie(app, { username: "alice", email: "alice@forge.test", password: "a-long-words-passphrase" });
    const alice = getUserByName(app.db, "alice")!;
    const made = await createRepo(app, alice, { name: "garden", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, { message: "seed", files: [{ path: "README.md", content: "# g\n" }] });
    const open = (title: string): Issue => {
      const made = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title });
      if (!made.ok) throw new Error(String(made.error));
      return made.value;
    };
    gate = open("Later gate: not yet");
    umbrella = open("Later: someday");
    child = open("Waits behind the gate");
    loose = open("Tidy the README");
    const linked = addDependency(app.db, child, gate, alice.id);
    if (!linked.ok) throw new Error(linked.error);
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("linkedIssueIds is exactly the issues on either end of an edge", () => {
    const all = [gate, umbrella, child, loose].map((i) => i.id);
    expect(linkedIssueIds(app.db, all)).toEqual(new Set([gate.id, child.id]));
    expect(linkedIssueIds(app.db, [loose.id, umbrella.id])).toEqual(new Set());
    expect(linkedIssueIds(app.db, [])).toEqual(new Set());
  });

  test("a batch words an issue on an edge as deferred, as the graph does", async () => {
    const [word] = await tellWords(ctx(), repo, [child], new Map());
    expect(word?.note).toStartWith("deferred:");
    expect(word).toEqual(await tellWord(ctx(), repo, child, undefined));
  });

  test("an issue on no edge is worded as it is without the shortcut", async () => {
    const [word] = await tellWords(ctx(), repo, [loose], new Map());
    expect(word?.note).not.toStartWith("deferred:");
    expect(word).toEqual(await tellWord(ctx(), repo, loose, undefined));
  });

  test("a Later umbrella on no edge still goes through the graph", async () => {
    const [word] = await tellWords(ctx(), repo, [umbrella], new Map());
    expect(word?.note).toStartWith("deferred:");
    expect(word).toEqual(await tellWord(ctx(), repo, umbrella, undefined));
  });

  test("an issue outside the batch, on the same context, still gets the graph path", async () => {
    const c = ctx();
    // The batch is in flight (its reads are set) when the other tell is worded.
    const batch = tellWords(c, repo, [loose], new Map());
    const outside = await tellWord(c, repo, child, undefined);
    await batch;
    expect(outside?.note).toStartWith("deferred:");
  });
});
