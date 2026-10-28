/**
 * The `flow` label's dispatcher, `src/crew/flow_label.ts`, imported and run
 * (#7512). Release 0.7.283 did not boot because of it (#7436), and no test
 * loaded it directly: `actions/issues.ts` loads it only when a label lands.
 * Imported first here, so a failure at import fails this file; then loaded
 * cold in a fresh process the way `src/main.ts` boots, through the label.
 *
 * Labelling a held issue `flow` starts its run, that issue only, paid by
 * whoever last assigned it; an issue that is not held, or has no assignee,
 * starts nothing and throws nothing.
 */
import { dispatchFlowLabelled } from "../src/crew/flow_label.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue, setIssueState } from "../src/actions/issues.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { getIssueById, getLabel, setIssueLabels, type Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { flowOnlyHolds } from "../src/crew/flow_only.ts";
import { sweepAssigned } from "../src/crew/dispatch.ts";

const BOOT = join(import.meta.dir, "helpers", "flow-label-boot.ts");

describe("the flow-label dispatcher", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let gus: User;
  let bot: User;
  let repo: Repo;

  const fresh = () => getRepoById(app.db, repo.id)!;
  const open = (title: string): Issue => {
    const o = openIssue(app, alice, fresh(), { title, body: "" });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };
  const assign = (issue: Issue, to: User | null = bot): Issue => {
    const a = assignIssue(app, alice, fresh(), issue, to);
    if (!a.ok) throw new Error(String(a.error));
    return a.value;
  };
  const runsOn = (issue: Issue): number =>
    app.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM run WHERE issue_id = ?1 AND kind = 'agent'")
      .get(issue.id)!.n;
  /** Who each run queued on the issue was announced as asked by: the account it is charged to. */
  const payers = (issue: Issue): (string | null)[] =>
    app.db
      .query<{ actor_id: string | null }, [string]>(
        `SELECT actor_id FROM event WHERE kind = 'run.queued' AND json_extract(payload, '$.issueId') = ?1 ORDER BY id`,
      )
      .all(issue.id)
      .map((r) => r.actor_id);
  /** Label `flow` as the store does, then hand the issue to the dispatcher. */
  const label = (issue: Issue): void => {
    setIssueLabels(app.db, issue.id, [getLabel(app.db, repo.id, "flow")!.id]);
    dispatchFlowLabelled(app, fresh(), getIssueById(app.db, issue.id)!);
  };
  /** An assignment recorded as a guest's: the dispatcher reads the assigner from the event. */
  const assignedBy = (issue: Issue, by: User): void => {
    app.bus.append({
      kind: "issue.assigned",
      repoId: repo.id,
      actorId: by.id,
      payload: { number: issue.number, assignee: bot.username },
    });
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-flow-label-dispatch-"));
    app = createApp({ dataDir, port: 0 });
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
    const g = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "gus",
      email: "gus@forge.local",
      password: "a-good-passphrase",
    });
    if (!g.ok) throw new Error(g.error);
    gus = g.value;
    const made = await createRepo(app, alice, { name: "svc", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const created = await createAgent(app, alice, { username: "bot" });
    if (!created.ok) throw new Error(String(created.error));
    expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
    bot = getUserByName(app.db, "bot")!;
    const on = await updateRepoSettings(app, alice, fresh(), { flowOnly: true });
    if (!on.ok) throw new Error(JSON.stringify(on.error));
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a held issue labelled `flow` starts exactly one run, that issue only, charged to its assigner", () => {
    const held = assign(open("Held"));
    const beside = assign(open("Beside, also held"));
    sweepAssigned(app);
    expect(flowOnlyHolds(app.db, fresh(), held)).toBe(true);
    expect(runsOn(held)).toBe(0);
    expect(runsOn(beside)).toBe(0);

    label(held);
    expect(runsOn(held)).toBe(1);
    expect(runsOn(beside)).toBe(0);
    expect(payers(held)).toEqual([alice.id]);

    // Labelled again, or swept, it is the same one run.
    label(held);
    sweepAssigned(app);
    expect(runsOn(held)).toBe(1);
    expect(runsOn(beside)).toBe(0);
  });

  test("the last assigner pays: a guest's last word starts nothing, an owner's after it does", () => {
    // Assigned by alice, then last by a guest: a guest's word starts no run.
    const guestLast = assign(open("Guest last"));
    assignedBy(guestLast, gus);
    label(guestLast);
    expect(runsOn(guestLast)).toBe(0);
    expect(payers(guestLast)).toEqual([]);

    // A guest first, then alice: alice is the last assigner, and pays.
    const ownerLast = open("Owner last");
    assignedBy(ownerLast, gus);
    assign(ownerLast);
    label(ownerLast);
    expect(runsOn(ownerLast)).toBe(1);
    expect(payers(ownerLast)).toEqual([alice.id]);
  });

  test("an issue that is not held, or has no assignee, starts nothing and throws nothing", () => {
    const nobody = open("No assignee");
    expect(() => label(nobody)).not.toThrow();
    expect(runsOn(nobody)).toBe(0);

    const person = assign(open("A person's"), alice);
    expect(() => label(person)).not.toThrow();
    expect(runsOn(person)).toBe(0);

    // Assigned while already labelled `flow`: never held, and its one run is the assignment's.
    const flowing = open("Already flow");
    setIssueLabels(app.db, flowing.id, [getLabel(app.db, repo.id, "flow")!.id]);
    assign(flowing);
    sweepAssigned(app);
    expect(flowOnlyHolds(app.db, fresh(), getIssueById(app.db, flowing.id)!)).toBe(false);
    expect(runsOn(flowing)).toBe(1);
    expect(() => label(flowing)).not.toThrow();
    expect(runsOn(flowing)).toBe(1);

    const closed = assign(open("Closed"));
    const shut = setIssueState(app, alice, fresh(), closed, "closed");
    if (!shut.ok) throw new Error(String(shut.error));
    expect(() => label(closed)).not.toThrow();
    expect(runsOn(closed)).toBe(0);
  });

  test("loaded cold as the forge boots, the label on a held issue starts its run", async () => {
    const held = assign(open("Held at boot"));
    expect(runsOn(held)).toBe(0);
    const child = Bun.spawn([process.execPath, BOOT, dataDir, "alice", "svc", String(held.number)], {
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
    });
    const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code: await child.exited, err: (await child.exited) === 0 ? "" : err }).toEqual({ code: 0, err: "" });
    expect(out.trim().split("\n").at(-1)).toBe("1");
    expect(runsOn(held)).toBe(1);
  }, 30_000);
});
