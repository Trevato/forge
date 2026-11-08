/**
 * The terminal's issue screen edits an issue's title and body with `e`
 * (#7235): the comment composer opens on the title, a blank line and the
 * body; `ctrl+d` saves through `editIssue`, the page then shows it and
 * its live viewers hear `issue.edited`; `esc` discards as the comment
 * composer cancels; a refusal reads in the action's words and keeps the
 * draft; and a reader `editIssue` refuses, or a mirror, has no `e`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assignIssue, openIssue, TAKEN_UP } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getIssue, type Issue } from "../src/core/issues.ts";
import { createOrigin, linkRepoToOrigin } from "../src/core/origins.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { editText, issueScreen, readEditText } from "../src/tui/screens/issue.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("the terminal's issue screen edits with e", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let repo: Repo;
  const fresh = () => getRepoById(app.db, repo.id)!;

  const newIssue = (by: User, title: string, body: string): Issue => {
    const o = openIssue(app, by, repo, { title, body });
    if (!o.ok) throw new Error(o.error);
    return o.value;
  };

  /** A terminal signed in as `user`, on the issue's screen. */
  const open = async (user: User, issue: Issue, on: Repo = fresh()) => {
    const terminal = headlessTerminal(140, 40);
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user },
      { terminal, exitHooks: false },
    );
    tui.start();
    await settleApp(tui);
    tui.push(issueScreen(session, tui.ctx, local(session, on), issue.number));
    await settleApp(tui);
    const key = async (k: string, ctrl = false) => {
      tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
      await settleApp(tui);
    };
    const paste = async (text: string) => {
      tui.dispatch({ type: "paste", text });
      await settleApp(tui);
    };
    return { tui, key, paste, text: () => tui.screen.toText() };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-issue-edit-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const username of ["alice", "bob"]) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: username === "alice",
      });
      if (!made.ok) throw new Error(made.error);
      if (username === "alice") alice = made.value;
      else bob = made.value;
    }
    const r = await createRepo(app, alice, { name: "garden", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the editor's text is the title, a blank line, then the body, and reads back", () => {
    expect(editText("A chart", "Draw it.")).toBe("A chart\n\nDraw it.");
    expect(readEditText("A chart\n\nDraw it.\n")).toEqual({ title: "A chart", body: "Draw it." });
    expect(readEditText(editText("Only a title", ""))).toEqual({ title: "Only a title", body: "" });
  });

  test("e opens the title and body, ctrl+d saves, and the page shows the new title", async () => {
    const issue = newIssue(alice, "A chart", "Draw the rainfall.");
    const t = await open(alice, issue);
    const heard: unknown[] = [];
    const off = app.bus.subscribe((event) => {
      if (event.kind === "issue.edited" && event.repoId === repo.id)
        heard.push({ actorId: event.actorId, ...event.payload });
    });
    try {
      expect(t.text()).toMatch(/\be  edit/);
      await t.key("e");
      expect(t.text()).toContain(`Edit #${issue.number}`);
      expect(t.text()).toContain("Draw the rainfall.");
      await t.paste("Monthly ");
      await t.key("d", true);
      const saved = getIssue(app.db, repo.id, issue.number)!;
      expect(saved.title).toBe("Monthly A chart");
      expect(saved.body).toBe("Draw the rainfall.");
      // What a web viewer's live stream is fed: the edit, by whom, to what.
      expect(heard).toEqual([{ actorId: alice.id, number: issue.number, changed: ["title"] }]);
      expect(t.text()).toContain("Monthly A chart");
      expect(t.text()).not.toContain(`Edit #${issue.number}`);
    } finally {
      off();
      t.tui.stop();
    }
    const page = await (await fetch(`${servers.url}/alice/garden/issues/${issue.number}`)).text();
    expect(page).toContain("Monthly A chart");
  });

  test("esc on an untouched draft discards without asking, and nothing changed", async () => {
    const issue = newIssue(alice, "A gate", "Hang it.");
    const t = await open(alice, issue);
    try {
      await t.key("e");
      await t.key("esc");
      expect(t.text()).not.toContain(`Edit #${issue.number}`);
      const kept = getIssue(app.db, repo.id, issue.number)!;
      expect(kept.title).toBe("A gate");
      expect(kept.body).toBe("Hang it.");
    } finally {
      t.tui.stop();
    }
  });

  test("esc on a changed draft discards it as a comment's is, and nothing changed", async () => {
    const issue = newIssue(alice, "A fence", "Paint it.");
    const t = await open(alice, issue);
    try {
      await t.key("e");
      await t.paste("Green ");
      await t.key("esc");
      expect(t.text()).not.toContain(`Edit #${issue.number}`);
      expect(getIssue(app.db, repo.id, issue.number)!.title).toBe("A fence");
    } finally {
      t.tui.stop();
    }
  });

  test("a refusal reads in the action's words and keeps the draft", async () => {
    const issue = newIssue(bob, "A shed", "Build it.");
    const t = await open(bob, issue);
    try {
      expect(t.text()).toMatch(/\be  edit/);
      await t.key("e");
      await t.paste("Tall ");
      // A writer adopts it while bob is typing: his words are now the crew's.
      const assigned = assignIssue(app, alice, fresh(), getIssue(app.db, repo.id, issue.number)!, alice);
      expect(assigned.ok).toBe(true);
      await t.key("d", true);
      expect(t.text()).toContain(TAKEN_UP);
      expect(t.text()).toContain("Tall A shed");
      expect(t.text()).toContain(`Edit #${issue.number}`);
      expect(getIssue(app.db, repo.id, issue.number)!.title).toBe("A shed");
    } finally {
      t.tui.stop();
    }
  });

  test("a reader who did not write it has no e, and pressing it changes nothing", async () => {
    const issue = newIssue(alice, "A pond", "Dig it.");
    const t = await open(bob, issue);
    try {
      expect(t.text()).not.toMatch(/\be  edit/);
      await t.key("e");
      expect(t.text()).not.toContain(`Edit #${issue.number}`);
      expect(getIssue(app.db, repo.id, issue.number)!.title).toBe("A pond");
    } finally {
      t.tui.stop();
    }
  });

  test("a mirror has no e, even for its writer, since editIssue refuses there", async () => {
    const made = await createRepo(app, alice, { name: "widgets", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const opened = openIssue(app, alice, made.value, { title: "A cog", body: "Turn it." });
    if (!opened.ok) throw new Error(opened.error);
    const o = createOrigin(app.db, dataDir, {
      userId: alice.id,
      kind: "forgejo",
      apiUrl: "https://codeberg.org/api/v1",
      webUrl: "https://codeberg.org",
      login: "alice",
      token: "t0ken",
    });
    if (!o.ok) throw new Error(o.error);
    linkRepoToOrigin(app.db, made.value.id, {
      originId: o.value.id,
      fullName: "octo/widgets",
      remoteId: "1",
      htmlUrl: "https://codeberg.org/octo/widgets",
    });
    const t = await open(alice, opened.value, getRepoById(app.db, made.value.id)!);
    try {
      expect(t.text()).toContain("A cog");
      expect(t.text()).not.toMatch(/\be  edit/);
      await t.key("e");
      expect(t.text()).not.toContain(`Edit #${opened.value.number}`);
    } finally {
      t.tui.stop();
    }
  });
});
