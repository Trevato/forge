/**
 * A retirement issue is checked against the base before it is handed out:
 * one whose classes are gone gets the already-done note and is skipped, one
 * whose classes remain is handed out, and one naming none is handed out.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { alreadyDone } from "../src/core/done_on_main.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { driveRepo } from "../src/crew/autonomy.ts";
import { retiredNames } from "../src/crew/retired.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";

describe("retiredNames", () => {
  test("only backticked .class tokens of a retirement title", () => {
    const body = "Done when `.a` and `.b-c` go; not `plain` or `x.y`.";
    expect(retiredNames({ title: "`.a` leaves the stylesheet", body })).toEqual([".a", ".b-c"]);
    expect(retiredNames({ title: "`.a` leaves §5d", body: "" })).toEqual([".a"]);
    expect(retiredNames({ title: "Add `.a`", body })).toEqual([]);
    expect(retiredNames({ title: "Rules leave the stylesheet", body: "none" })).toEqual([]);
  });
});

describe("the picker and retirement issues", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  const fresh = () => getRepoById(app.db, repo.id)!;
  let removal = "";

  const ask = (title: string, body = ""): Issue => {
    const o = openIssue(app, alice, fresh(), { title, body });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };
  const drop = (issue: Issue) =>
    setIssueState(app, alice, fresh(), getIssueById(app.db, issue.id)!, "closed", { reason: "dropped" });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-retired-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, { name: "styles", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const first = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "src/app.css", content: ".old { color: red }\n.keep { color: blue }\n" }],
    });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    const second = await commitToBranch(app, alice, repo, {
      message: "Retire .old",
      files: [{ path: "src/app.css", content: ".keep { color: blue }\n" }],
    });
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    removal = (await resolveOid(repoDir(app.reposRoot, repo.ownerName, repo.name), `refs/heads/${repo.defaultBranch}`))!;
    const agent = await createAgent(app, alice, { username: "mason" });
    if (!agent.ok) throw new Error(String(agent.error));
    expect(addToCrew(app, alice, repo, "mason").ok).toBe(true);
    const on = await updateRepoSettings(app, alice, repo, {
      autonomy: "autonomous",
      autonomyDirection: "Retire the old rules.",
      autonomyCeilingUsd: 10,
      autonomySlots: 1,
      autonomyBy: alice.id,
    });
    expect(on.ok).toBe(true);
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("classes already gone: the note names the removing commit and nothing is handed out", async () => {
    const gone = ask("`.old` leaves the stylesheet", "Done when `.old` is gone.");
    expect(await driveRepo(app, fresh())).not.toBe("picked");
    expect(getIssueById(app.db, gone.id)!.assigneeId).toBeNull();
    expect(alreadyDone(app.db, [gone.id]).get(gone.id)).toEqual([removal]);
    // Said once, however many ticks follow.
    await driveRepo(app, fresh());
    const notes = app.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM comment WHERE issue_id = ?1 AND body LIKE 'Done on main already%'")
      .get(gone.id)!;
    expect(notes.n).toBe(1);
    drop(gone);
  });

  test("classes that remain: the issue is handed out", async () => {
    const kept = ask("`.keep` leaves the stylesheet", "Done when `.keep` is gone.");
    expect(await driveRepo(app, fresh())).toBe("picked");
    expect(getIssueById(app.db, kept.id)!.assigneeId).not.toBeNull();
    expect(alreadyDone(app.db, [kept.id]).size).toBe(0);
  });

  test("no names: the issue is handed out as before", async () => {
    const kept = getIssueById(app.db, (await Promise.resolve(ask("Old rules leave the stylesheet", "No names here."))).id)!;
    // The previous test's issue holds the one slot; free it first.
    app.db.query("UPDATE issue SET assignee_id = NULL WHERE assignee_id IS NOT NULL").run();
    app.db.query("UPDATE issue SET state = 'closed' WHERE id != ?1").run(kept.id);
    expect(await driveRepo(app, fresh())).toBe("picked");
    expect(getIssueById(app.db, kept.id)!.assigneeId).not.toBeNull();
  });
});
