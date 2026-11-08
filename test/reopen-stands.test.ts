/**
 * #8375 (issue #8373): a person's reopen stands against "already done on main", and a
 * landing never closes an issue that still has unticked items.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addComment, openIssue, setIssueState } from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { getIssue, getIssueById, listComments, type Issue } from "../src/core/issues.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepoById, updateRepoSettings as setRepo, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { ALREADY_NOTE } from "../src/crew/already.ts";
import { closeSuperseded } from "../src/crew/autonomy.ts";
import { liveTriage } from "../src/crew/livetriage.ts";
import { reopenedByPerson, unticked } from "../src/core/done_on_main.ts";

describe("a reopen stands; unfinished work stays open", () => {
  let dir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  let oid: string;
  const fresh = () => getRepoById(app.db, repo.id)!;
  const issue = (title: string, body = ""): Issue => {
    const opened = openIssue(app, alice, fresh(), { title, body });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  };
  const state = (on: Issue) => getIssueById(app.db, on.id)!.state;
  const pullFor = async (branch: string, body: string) => {
    const pushed = await commitToBranch(app, alice, fresh(), {
      branch,
      message: branch,
      files: [{ path: `${branch}.txt`, content: "x\n" }],
    });
    if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
    const pull = await openPull(app, alice, fresh(), {
      title: branch,
      body,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!pull.ok) throw new Error(String(pull.error));
    return getPull(app.db, repo.id, pull.value.number)!;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-reopen-stands-"));
    app = createApp({ dataDir: dir, port: 0 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, { name: "engine", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const set = await updateRepoSettings(app, alice, repo, {
      autonomy: "autonomous",
      autonomyDirection: "Keep it small.",
      autonomyCeilingUsd: 100,
    });
    if (!set.ok) throw new Error(JSON.stringify(set.error));
    setRepo(app.db, fresh(), { autonomyBy: alice.id });
    const seeded = await commitToBranch(app, alice, fresh(), {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    oid = seeded.value.commitOid;
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("unticked items are read from the body", () => {
    expect(unticked("- [x] a\n- [ ] b\n* [ ] c\nnot - [ ] d")).toEqual(["b", "c"]);
  });

  test("fenced code and quoted templates are not unticked items", () => {
    expect(unticked("- [x] a\n```md\n- [ ] in fence\n```\n- [ ] real\n~~~\n- [ ] tilde\n~~~")).toEqual(["real"]);
    expect(unticked("```\n- [ ] never closed")).toEqual([]);
  });

  test("a reopen with no actor is not a person's", async () => {
    const orphan = issue("Reopened by nobody");
    setIssueState(app, alice, fresh(), orphan, "closed");
    app.bus.append({
      kind: "issue.reopened",
      repoId: repo.id,
      payload: { number: orphan.number },
    });
    expect(reopenedByPerson(app.db, repo.id, orphan.number)).toBe(false);
    addComment(app, alice, fresh(), orphan, `${ALREADY_NOTE}${oid}`);
    const pull = await pullFor("superseded-null", `Closes #${orphan.number}`);
    expect(closeSuperseded(app, fresh(), pull, [oid])).toBe(true);
    expect(state(orphan)).toBe("closed");
  });

  test("live triage leaves a reopened issue open even with no earlier close note", async () => {
    const reopened = issue("Reopened by hand");
    expect(setIssueState(app, alice, fresh(), reopened, "closed").ok).toBe(true);
    expect(setIssueState(app, alice, fresh(), getIssueById(app.db, reopened.id)!, "open").ok).toBe(true);
    addComment(app, alice, fresh(), reopened, `${ALREADY_NOTE}${oid}`);
    expect((await liveTriage(app, fresh())).closed).toBe(0);
    expect(state(reopened)).toBe("open");
  });

  test("a superseded pull does not re-close a reopened issue (the #8042 case)", async () => {
    const asked = issue("Reopened with work left");
    setIssueState(app, alice, fresh(), asked, "closed");
    setIssueState(app, alice, fresh(), getIssueById(app.db, asked.id)!, "open");
    const pull = await pullFor("superseded-a", `Closes #${asked.number}`);
    expect(closeSuperseded(app, fresh(), pull, [oid])).toBe(true);
    expect(state(asked)).toBe("open");
    expect(listComments(app.db, asked.id).some((c) => c.body.startsWith("Closed: already done"))).toBe(false);
  });

  test("a superseded pull still closes an issue nobody reopened", async () => {
    const plain = issue("Plain");
    const pull = await pullFor("superseded-b", `Closes #${plain.number}`);
    expect(closeSuperseded(app, fresh(), pull, [oid])).toBe(true);
    expect(state(plain)).toBe("closed");
  });

  test("a landing leaves an issue with unticked items open and says so on the pull", async () => {
    const partial = issue("Partial", "- [x] one\n- [ ] two\n- [ ] three");
    const whole = issue("Whole", "- [x] one");
    const pull = await pullFor("lands", `Closes #${partial.number}, closes #${whole.number}`);
    const merged = await mergePull(app, alice, fresh(), pull, "squash");
    expect(merged.ok).toBe(true);
    expect(state(partial)).toBe("open");
    expect(state(whole)).toBe("closed");
    const lines = listComments(app.db, getIssue(app.db, repo.id, pull.number)!.id).map((c) => c.body);
    const events = app.db
      .query<{ payload: string }, [string]>("SELECT payload FROM event WHERE kind = 'pull.commented' AND repo_id = ?1")
      .all(repo.id)
      .map((e) => JSON.parse(e.payload).body);
    expect(events).toContain(lines[0]!);
    expect(lines).toEqual([`Left #${partial.number} open: 2 unticked items remain (two; three).`]);
  });

  test("a pull that lands after a reopen closes it", async () => {
    const back = issue("Back again");
    setIssueState(app, alice, fresh(), back, "closed");
    setIssueState(app, alice, fresh(), getIssueById(app.db, back.id)!, "open");
    const pull = await pullFor("lands-2", `Closes #${back.number}`);
    expect((await mergePull(app, alice, fresh(), pull, "squash")).ok).toBe(true);
    expect(state(back)).toBe("closed");
  });
});
