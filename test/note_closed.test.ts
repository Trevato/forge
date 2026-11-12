/** A merged pull that closes a note tells its sender, once, in plain words (#10564). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { notesFor, sendNote, type Sender } from "../src/actions/app_notes.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getAppBySlug } from "../src/core/apps.ts";
import { getIssue, listComments, addComment, setIssueState } from "../src/core/issues.ts";
import { getPull } from "../src/core/pulls.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { applyBoxPass } from "../src/actions/box_pass.ts";
import { recordRelease } from "../src/release/record.ts";
import { noteReleased, plainSummary, shippedWords, tellNoteShipped } from "../src/crew/note_closed.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("plainSummary", () => {
  test("drops hashes, links, code, closings and markup", () => {
    const out = plainSummary(
      "t",
      "## What\n\nThe **button** was hidden on phones (see https://x.test/a, `src/a.ts`, 0123abcd45ef).\n\nCloses #12\n\n```\ncode\n```\n\n- tests",
    );
    expect(out).not.toMatch(/https?:|`|\*|0123abcd|#12|code\n/);
    expect(out).toContain("The button was hidden on phones");
  });
  test("keeps the attribution line out of a short description", () => {
    const out = plainSummary("t", "Fixed the tiny button.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude <x@y.z>");
    expect(out).toBe("Fixed the tiny button.");
  });
  test("strips hashes but not words or numbers", () => {
    const out = plainSummary("t", "The defaced banner showed 1234567 visitors, was in commit 0123abcd45ef (also 9f8e7d6c5b4a).");
    expect(out).toContain("defaced");
    expect(out).toContain("1234567");
    expect(out).not.toMatch(/0123abcd|9f8e7d6c|\(\)|commit/);
  });
  test("falls back to the title and stays short", () => {
    expect(plainSummary("Make it blue", "")).toBe("Make it blue");
    expect(plainSummary("t", "word ".repeat(400)).length).toBeLessThanOrEqual(600);
  });
});

describe("a closing pull tells the note's sender", () => {
  let dataDir: string;
  let app: App;
  let alice: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-note-closed-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.test", adminIfFirst: true });
    if (!made.ok) throw new Error(String(made.error));
    alice = made.value;
    const a = await newApp(app, alice, { name: "sandbox-game", description: "Words", visibility: "private" });
    if (!a.ok) throw new Error(String(a.error));
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  test("merging posts one comment, a second delivery posts none, and the status reads shipped", async () => {
    const record = getAppBySlug(app.db, "sandbox-game")!;
    const repo = getRepo(app.db, "alice", "sandbox-game")!;
    const who: Sender = { key: "v:closer1", name: "visitor", person: false };
    const sent = await sendNote(app, record, repo, "production", undefined, who, { text: "the button is tiny", page: "", viewport: "390x844" }, "10.2.0.1");
    if (!sent.ok) throw new Error(sent.error.message);
    const n = sent.value.number;
    expect(sent.value.status.state).not.toBe("shipped");

    const body = `The button was too small to tap on phones. It is now 48px tall (commit 0123abcd45ef).\n\nCloses #${n}`;
    const seeded = await commitToBranch(app, alice, repo, { message: "seed", files: [{ path: "README.md", content: "hi\n" }] });
    expect(seeded.ok).toBe(true);
    const branched = await commitToBranch(app, alice, repo, { branch: "fix", base: "main", message: "fix", files: [{ path: "a.txt", content: "x\n" }] });
    expect(branched.ok).toBe(true);
    const opened = await openPull(app, alice, repo, { title: "Bigger button", body, baseBranch: "main", headBranch: "fix" });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const merged = await mergePull(app, alice, repo, opened.value, "squash");
    expect(merged.ok).toBe(true);

    const issue = getIssue(app.db, repo.id, n)!;
    expect(issue.state).toBe("closed");
    const said = () => listComments(app.db, issue.id, { kind: "comment" }).filter((c) => c.body.startsWith("Good news"));
    expect(said()).toHaveLength(1);
    expect(said()[0]!.body).toContain("too small to tap on phones");
    expect(said()[0]!.body).not.toMatch(/0123abcd|#\d/);
    expect(said()[0]!.body).toContain("next release");

    // Re-delivery: the same landing again says nothing more.
    expect(tellNoteShipped(app.db, alice.id, issue, opened.value)).toBeUndefined();
    expect(said()).toHaveLength(1);

    const note = notesFor(app, record, repo, undefined, who)[0]!;
    expect(note.status.state).toBe("shipped");
    expect(note.replies.map((r) => r.text)).toEqual([said()[0]!.body]);
  });

  test("an issue that is not a note hears nothing", async () => {
    const repo = getRepo(app.db, "alice", "sandbox-game")!;
    const { openIssueThrough } = await import("../src/actions/issues.ts");
    const plainIssue = await openIssueThrough(app, alice, repo, { title: "Plain", body: "x" });
    if (!plainIssue.ok) throw new Error(String(plainIssue.error));
    const pull = { number: 1, repoId: repo.id, title: "t", body: "" } as never;
    expect(tellNoteShipped(app.db, alice.id, plainIssue.value, pull)).toBeUndefined();
    expect(shippedWords(pull, "abc")).toContain("shipped in abc");
  });

  async function land(text: string, title: string, bodyOf: (n: number) => string, branch: string, merge = true) {
    const record = getAppBySlug(app.db, "sandbox-game")!;
    const repo = getRepo(app.db, "alice", "sandbox-game")!;
    const who: Sender = { key: `v:${branch}`, name: "visitor", person: false };
    const sent = await sendNote(app, record, repo, "production", undefined, who, { text, page: "", viewport: "390x844" }, `10.2.0.${branch.length}`);
    if (!sent.ok) throw new Error(sent.error.message);
    const n = sent.value.number;
    const b = await commitToBranch(app, alice, repo, { branch, base: "main", message: branch, files: [{ path: `${branch}.txt`, content: "x\n" }] });
    expect(b.ok).toBe(true);
    const opened = await openPull(app, alice, repo, { title, body: bodyOf(n), baseBranch: "main", headBranch: branch });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    if (merge) expect((await mergePull(app, alice, repo, opened.value, "squash")).ok).toBe(true);
    return { n, repo, pull: opened.value, record, who };
  }
  const marked = (issueId: string) => app.db.query("SELECT comment_id FROM note_shipped WHERE issue_id = ?1").all(issueId);

  test("a person's comment that opens the same way does not stand in for the forge's", async () => {
    const { n, repo } = await land("the logo is blurry", "Sharper logo", (k) => `The logo was blurry. It is sharp now.\n\nCloses #${k}`, "logo", false);
    const issue = getIssue(app.db, repo.id, n)!;
    addComment(app.db, { issueId: issue.id, authorId: alice.id, body: "Good news: this is fixed, says a person" });
    const pull = getPullFor(repo.id, "logo");
    expect(tellNoteShipped(app.db, alice.id, issue, pull)).toBeDefined();
    expect(marked(issue.id)).toHaveLength(1);
  });

  test("the comment names the release once one is cut, in words, not a hash", async () => {
    const { n, repo, pull } = await land("the footer overlaps", "Fix footer", (k) => `The footer overlapped the text. It no longer does.\n\nCloses #${k}`, "footer");
    const issue = getIssue(app.db, repo.id, n)!;
    const text = () => listComments(app.db, issue.id, { kind: "comment" }).filter((c) => c.body.startsWith("Good news"));
    expect(text()[0]!.body).toContain("next release");
    expect(noteReleased(app.db, recordRelease(app.db, { sha: "f00dfeedcafe1234", repoId: repo.id, pullNumber: pull.number, ok: false, line: "bad" }))).toBe(0);
    const rel = recordRelease(app.db, { sha: "f00dfeedcafe1234", repoId: repo.id, pullNumber: pull.number, ok: true, line: "ok" });
    expect(noteReleased(app.db, rel)).toBe(1);
    expect(text()).toHaveLength(1);
    expect(text()[0]!.body).toContain(`release ${rel.id} (`);
    expect(text()[0]!.body).not.toMatch(/next release|f00dfeed/);
    expect(text()[0]!.body).toContain("footer overlapped");
  });

  test("the box pass's closing path tells the sender too, once", async () => {
    const { n, repo, pull } = await land("the menu is cut off", "Menu fits", (k) => `The menu was cut off. It fits now.\n\nCloses #${k}`, "menu");
    const issue = getIssue(app.db, repo.id, n)!;
    // As if the pull had landed before its boxes were read: the issue is open and unannounced.
    app.db.query("DELETE FROM comment WHERE id = (SELECT comment_id FROM note_shipped WHERE issue_id = ?1)").run(issue.id);
    expect(marked(issue.id)).toHaveLength(0);
    setIssueState(app.db, issue.id, "open");
    const merged = getPullFor(repo.id, "menu");
    const pass = { ticks: [{ issue: n, box: 1, text: "x" }] };
    applyBoxPass(app, repo, merged, alice, pass);
    expect(getIssue(app.db, repo.id, n)!.state).toBe("closed");
    const said = () => listComments(app.db, issue.id, { kind: "comment" }).filter((c) => c.body.startsWith("Good news"));
    expect(said()).toHaveLength(1);
    expect(said()[0]!.body).toContain("menu was cut off");
    expect(pull.number).toBe(merged.number);
  });

  function getPullFor(repoId: string, head: string) {
    const row = app.db.query<{ number: number }, [string, string]>("SELECT issue.number FROM pull JOIN issue ON issue.id = pull.issue_id WHERE issue.repo_id = ?1 AND pull.head_branch = ?2").get(...([repoId, head] as [string, string]));
    if (row === null) throw new Error("no pull");
    return getPull(app.db, repoId, row.number)!;
  }
});
