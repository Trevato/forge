/**
 * The client tells the crew from the app's page and reads the answer under
 * the box (#1989): the tell goes in through the same-origin form, a stand-in
 * run answers, and the answer is on the page and in its live fragment.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableApp } from "../src/actions/apps.ts";
import { TOO_LONG_WORDS } from "../src/actions/tell.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { addComment, listIssues } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { answerLines, answersScreen } from "../src/tui/screens/answers.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("the crew's answer under the tell box", () => {
  let dir = "";
  let app: App;
  let servers: Servers;
  let repo: Repo;
  let alice = "";
  let bob = "";

  const signIn = async (username: string): Promise<string> =>
    (
      (
        await fetch(`${servers.url}/signin`, {
          method: "POST",
          body: new URLSearchParams({ username, password: "a-good-passphrase" }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
  const get = (cookie: string, path: string) =>
    fetch(`${servers.url}${path}`, { headers: { cookie }, redirect: "manual" });
  const tell = (cookie: string, text: string, origin = servers.url) =>
    fetch(`${servers.url}/alice/notes/tell`, {
      method: "POST",
      headers: { cookie, origin },
      body: new URLSearchParams({ text }),
      redirect: "manual",
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-answers-"));
    app = createApp({ dataDir: dir, port: 0 });
    servers = await serve(app);
    for (const name of ["alice", "bob"]) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: name,
        email: `${name}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!made.ok) throw new Error(made.error);
    }
    const owner = getUserByName(app.db, "alice")!;
    const made = await createRepo(app, owner, { name: "notes", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, owner, repo, {
      message: "Start",
      files: [
        { path: "package.json", content: '{"name":"notes","scripts":{"start":"bun run server.ts"}}\n' },
        { path: "server.ts", content: "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n" },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, owner, repo, { slug: "notes" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    const scout = await createAgent(app, owner, { username: "scout" });
    if (!scout.ok) throw new Error(String(scout.error));
    expect(addToCrew(app, owner, repo, "scout").ok).toBe(true);
    alice = await signIn("alice");
    bob = await signIn("bob");
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("a tell goes in, a stand-in run answers, and the answer is on the page and in the fragment, newest first", async () => {
    expect((await tell(alice, "Make the <b>header</b> bigger.")).status).toBe(303);
    const first = listIssues(app.db, repo.id, { limit: 5 })[0]!;
    // Told, and nobody has answered yet.
    expect(await (await get(alice, "/alice/notes")).text()).toContain("Waiting for the crew.");

    // The stand-in run: queued for the builder, then claimed and finished
    // with a summary, as a builder's would be.
    const scout = getUserByName(app.db, "scout")!;
    const run = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: first.id, actorId: scout.id, reason: "assigned" });
    expect(await (await get(alice, "/alice/notes/app/answers")).text()).toContain("The crew is working on it.");
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state: "ok", summary: "Made the header bigger <script>x</script>." });

    await tell(alice, "Add a footer.");
    const second = listIssues(app.db, repo.id, { limit: 5 })[0]!;
    expect(second.number).toBeGreaterThan(first.number);
    addComment(app.db, { issueId: second.id, authorId: scout.id, body: "Footer added on a branch." });

    const page = await (await get(alice, "/alice/notes")).text();
    expect(page).toContain('id="live-answers"');
    expect(page).toContain("Made the header bigger &lt;script&gt;x&lt;/script&gt;.");
    expect(page).not.toContain("<script>x</script>");
    expect(page).toContain("Make the &lt;b&gt;header&lt;/b&gt; bigger.");
    expect(page).toContain("Footer added on a branch.");

    const frag = await (await get(alice, "/alice/notes/app/answers")).text();
    expect(frag).toContain("Footer added on a branch.");
    // The home page's language: rows under a heading, no boxed card.
    for (const body of [page, frag]) {
      const from = body.indexOf('id="live-answers"');
      const region = body.slice(from, body.indexOf("</section>", from));
      expect(region).toContain('<section class="settings-block">');
      expect(region).toMatch(/<h2>The crew(&#39;|')s answers<\/h2>/);
      expect(region).not.toContain('class="card');
      expect(region).not.toContain("card-head");
    }
    expect(frag.indexOf("Add a footer.")).toBeLessThan(frag.indexOf("Make the &lt;b&gt;"));
  });

  test("only the client's own app: a stranger has no box, no answers, and cannot tell", async () => {
    const page = await (await get(bob, "/alice/notes")).text();
    expect(page).not.toContain('id="tell"');
    expect(page).not.toContain("Footer added on a branch.");
    expect((await get(bob, "/alice/notes/app/answers")).status).toBe(404);
    const before = listIssues(app.db, repo.id, { state: "all", limit: 50 }).length;
    await tell(bob, "I am not the owner.");
    expect(listIssues(app.db, repo.id, { state: "all", limit: 50 }).length).toBe(before);
  });

  test("a cross-origin tell and an over-long one open nothing", async () => {
    const before = listIssues(app.db, repo.id, { state: "all", limit: 50 }).length;
    expect((await tell(alice, "from elsewhere", "https://evil.test")).status).toBeGreaterThanOrEqual(400);
    const long = await tell(alice, "x".repeat(70_000));
    const flash = long.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    const shown = await (await fetch(new URL(long.headers.get("location")!, servers.url), { headers: { cookie: `${alice}; ${flash}` } })).text();
    expect(shown).toContain(TOO_LONG_WORDS);
    expect(listIssues(app.db, repo.id, { state: "all", limit: 50 }).length).toBe(before);
  });

  test("the terminal shows the same answers to the owner, and nothing to a stranger", async () => {
    const screen = async (who: string): Promise<{ text: string; count: number }> => {
      const user = getUserByName(app.db, who)!;
      const { app: tui, session } = createForgeApp(
        app,
        { sshUsername: who, remoteAddress: "127.0.0.1", user },
        { terminal: headlessTerminal(120, 30), exitHooks: false },
      );
      tui.start();
      await settleApp(tui);
      tui.push(answersScreen(session, tui.ctx, repo));
      await settleApp(tui);
      const text = tui.screen.toText();
      const count = answerLines(session, repo).length;
      tui.stop();
      return { text, count };
    };
    const mine = await screen("alice");
    expect(mine.count).toBeGreaterThan(0);
    expect(mine.text).toContain("Add a footer.");
    expect(mine.text).toContain("Footer added on a branch.");
    const theirs = await screen("bob");
    expect(theirs.count).toBe(0);
    expect(theirs.text).not.toContain("Add a footer.");
  });
});
