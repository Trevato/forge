/**
 * #8482: an issue whose pull landed with boxes unticked goes to a person,
 * not back to a builder. The landing notes it on the issue, the picker
 * holds it under `landed`, and a person's comment or edit since the merge
 * makes it pickable again; an agent's word does not.
 */
import { seatAs } from "./helpers/seat.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { addComment, editIssue, openIssue } from "../src/actions/issues.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import {} from "../src/core/agents.ts";
import { landedNote } from "../src/core/done_on_main.ts";
import type { ForgeEvent } from "../src/core/events.ts";
import { getIssueById, listComments, setAssignee, type Issue } from "../src/core/issues.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { driveRepo } from "../src/crew/autonomy.ts";
import { route } from "../src/crew/dispatch.ts";
import { heldNow, heldWords } from "../src/crew/held.ts";
import { landedUnanswered } from "../src/crew/landed.ts";

describe("a landing with boxes unticked waits for a person", () => {
  let dir: string;
  let app: App;
  let alice: User;
  let mason: User;
  let repo: Repo;
  const fresh = () => getRepoById(app.db, repo.id)!;
  const now = (on: Issue) => getIssueById(app.db, on.id)!;
  const issue = (title: string, body: string): Issue => {
    const opened = openIssue(app, alice, fresh(), { title, body });
    if (!opened.ok) throw new Error(String(opened.error));
    return opened.value;
  };
  const land = async (branch: string, closes: Issue) => {
    const pushed = await commitToBranch(app, alice, fresh(), {
      branch,
      message: branch,
      files: [{ path: `${branch}.txt`, content: "x\n" }],
    });
    if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
    const opened = await openPull(app, alice, fresh(), {
      title: branch,
      body: `Closes #${closes.number}`,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = getPull(app.db, repo.id, opened.value.number)!;
    const merged = await mergePull(app, alice, fresh(), pull, "squash");
    if (!merged.ok) throw new Error(String(merged.error));
    return pull;
  };
  const held = (on: Issue) => heldNow(app, fresh()).by.landed.some((i) => i.id === on.id);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-landed-held-"));
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
    for (const agent of ["atlas", "mason"]) {
      const created = await createAgent(app, alice, { username: agent });
      if (!created.ok) throw new Error(String(created.error));
      expect(addToCrew(app, alice, made.value, agent).ok).toBe(true);
    }
    seatAs(app.db, made.value.id, getUserByName(app.db, "atlas")!.id, "planner");
    mason = getUserByName(app.db, "mason")!;
    const set = await updateRepoSettings(app, alice, made.value, {
      autonomy: "autonomous",
      autonomyDirection: "Keep the engine small.",
      autonomyCeilingUsd: 100,
      autonomySlots: 1,
      autonomyBy: alice.id,
    });
    if (!set.ok) throw new Error(JSON.stringify(set.error));
    repo = getRepoById(app.db, made.value.id)!;
    const seeded = await commitToBranch(app, alice, fresh(), {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("the landing leaves it open, notes it on the issue, and the picker passes it by", async () => {
    const partial = issue("Partial", "- [x] one\n- [ ] two");
    const pull = await land("lands-partial", partial);
    expect(now(partial).state).toBe("open");
    const notes = listComments(app.db, partial.id).map((c) => c.body);
    expect(notes).toEqual([landedNote(pull.number, ["two"])]);
    expect(notes[0]).toBe(
      `Left open after pull #${pull.number} landed: 1 unticked item remains (two). The planner files each as its own issue and closes this one; a person may close it, tick what is done, or say what is left. Until then the crew does not pick it again.`,
    );
    // The landing's own note, though alice wrote it, is not an answer.
    expect(landedUnanswered(app.db, fresh(), now(partial))?.number).toBe(pull.number);
    const sorted = heldNow(app, fresh());
    expect(sorted.by.landed.map((i) => i.number)).toEqual([partial.number]);
    expect(sorted.startable.some((r) => r.issue.id === partial.id)).toBe(false);
    expect(heldWords(sorted)).toContain("landed=1");
    await driveRepo(app, fresh());
    expect(now(partial).assigneeId).toBeNull();
  });

  test("the landing's note wakes no builder; a person's word still does", async () => {
    const partial = issue("Quiet", "- [ ] left");
    setAssignee(app.db, partial.id, mason.id);
    const say = (body: string) => {
      expect(addComment(app, alice, fresh(), now(partial), body).ok).toBe(true);
      route(app, {
        kind: "issue.commented",
        repoId: repo.id,
        actorId: alice.id,
        payload: { number: partial.number, body },
      } as unknown as ForgeEvent);
    };
    const woken = () =>
      app.db
        .query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM run WHERE issue_id = ?1 AND reason = 'feedback'",
        )
        .get(partial.id)?.n;
    say(landedNote(7, ["left"]));
    expect(woken()).toBe(0);
    say("Please finish the last box.");
    expect(woken()).toBe(1);
  });

  test("an agent's comment does not lift it; a person's does, and the picker hands it out", async () => {
    const partial = issue("Spoken", "- [ ] left");
    await land("lands-spoken", partial);
    expect(held(partial)).toBe(true);
    expect(addComment(app, mason, fresh(), now(partial), "I could redo this.").ok).toBe(true);
    expect(held(partial)).toBe(true);
    expect(addComment(app, alice, fresh(), now(partial), "The second half is still to do.").ok).toBe(true);
    expect(held(partial)).toBe(false);
    expect(heldNow(app, fresh()).startable.some((r) => r.issue.id === partial.id)).toBe(true);
  });

  test("a person ticking a box lifts it", async () => {
    const partial = issue("Ticked", "- [ ] a\n- [ ] b");
    await land("lands-ticked", partial);
    expect(held(partial)).toBe(true);
    expect(editIssue(app, alice, fresh(), now(partial), { body: "- [x] a\n- [ ] b" }).ok).toBe(true);
    expect(held(partial)).toBe(false);
  });

  test("an issue with every box ticked closes on the landing and holds nothing", async () => {
    const whole = issue("Whole", "- [x] all");
    await land("lands-whole", whole);
    expect(now(whole).state).toBe("closed");
    expect(listComments(app.db, whole.id)).toEqual([]);
    expect(landedUnanswered(app.db, fresh(), now(whole))).toBeUndefined();
  });

  test("an open issue no merged pull closes is not held", () => {
    const plain = issue("Plain", "- [ ] todo");
    expect(landedUnanswered(app.db, fresh(), now(plain))).toBeUndefined();
  });
});
