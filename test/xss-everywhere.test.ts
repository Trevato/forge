/**
 * One hostile string travels everywhere: as the title and body of an issue,
 * a pull and a tell, and as a repository's description. Every page, feed and
 * card that draws it shows it as text, never as markup.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { tell } from "../src/actions/tell.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { CARD_SHELL } from "../src/web/studio/cards.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { Screen } from "../src/tui/app/app.ts";
import { issueScreen } from "../src/tui/screens/issue.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { repoScreen } from "../src/tui/screens/repo.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { serve, type Servers } from "../src/http/server.ts";

const EVIL = `<img src=x onerror=alert(1)>"'`;
// What an escaped copy looks like, whichever of the escapers drew it.
const ESCAPED = "&lt;img src=x onerror=alert(1)&gt;";

describe("one hostile string, every surface", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let token: string;
  let issueNo: number;
  let pullNo: number;
  let id = 1;
  let alice: User;
  let game: Repo;

  const get = async (path: string) => {
    const res = await fetch(`${servers.url}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return res.text();
  };
  const mcp = async (name: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: id++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    return res.text();
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-xss-all-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
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
    token = createToken(app.db, a.value.id, "rw", "rw").token;
    const repo = await createRepo(app, a.value, {
      name: "game",
      visibility: "public",
      description: EVIL,
    });
    if (!repo.ok) throw new Error(String(repo.error));
    game = repo.value;
    // Explore lists apps, so the repository is one.
    const rec = insertApp(app.db, { repoId: repo.value.id, slug: "alice-game", access: "public" });
    if (!rec.ok) throw new Error(rec.error);
    const issue = createIssue(app.db, {
      repoId: repo.value.id,
      authorId: a.value.id,
      title: EVIL,
      body: EVIL,
    });
    if (!issue.ok) throw new Error(issue.error);
    issueNo = issue.value.number;
    // A real pull needs two real branches.
    const work = await mkdtemp(join(tmpdir(), "forge-xss-all-work-"));
    const env = gitClientEnv();
    const git = async (...args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd: work, env, stdout: "pipe", stderr: "pipe" });
      const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
    };
    const remote = `${servers.url.replace("http://", `http://alice:${token}@`)}/alice/game.git`;
    await git("init", "-b", "main");
    await Bun.write(join(work, "a.txt"), "a\n");
    await git("add", ".");
    await git("commit", "-m", "genesis");
    await git("push", remote, "main");
    await git("checkout", "-b", "topic");
    await Bun.write(join(work, "b.txt"), "b\n");
    await git("add", ".");
    await git("commit", "-m", "topic");
    await git("push", remote, "topic");
    await rm(work, { recursive: true, force: true });
    const made = await fetch(`${servers.url}/api/v1/repos/alice/game/pulls`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ title: EVIL, body: EVIL, base: "main", head: "topic" }),
    });
    if (made.status !== 201) throw new Error(`pull: ${made.status} ${await made.text()}`);
    pullNo = ((await made.json()) as { number: number }).number;
    const told = await tell(app, a.value, repo.value, EVIL);
    if (!told.ok) throw new Error(String(told.error));
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const pages: [string, () => string][] = [
    ["the home feed", () => "/feed"],
    ["the issue", () => `/alice/game/issues/${issueNo}`],
    ["the pull", () => `/alice/game/pulls/${pullNo}`],
    ["the issue list", () => "/alice/game/issues"],
    ["search", () => "/search?q=img"],
    ["explore", () => "/explore"],
    ["asked", () => "/asked"],
    ["the repository home", () => "/alice/game"],
    ["the activity feed", () => "/alice/game/activity.atom"],
    ["the waves feed", () => "/alice/game/waves.atom"],
  ];
  for (const [label, path] of pages)
    test(`${label} draws it as text`, async () => {
      const html = await get(path());
      expect(html).not.toContain("<img");
      expect(html).not.toContain(`onerror=alert(1)>"`);
      // Not vacuous: the page drew the string, as text.
      expect(html).toContain(ESCAPED);
    });

  test("the tell is drawn as text beside the issue on the issue list", async () => {
    const list = await get("/alice/game/issues");
    // The issue and the tell are two rows, each with the escaped title.
    expect(list.split(ESCAPED).length - 1).toBeGreaterThanOrEqual(2);
  });

  test("the terminal draws the issue, the pull and the repository without control bytes", async () => {
    const terminal = headlessTerminal(160, 50);
    const { app: tui, session } = createForgeApp(
      app,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user: alice },
      { terminal, exitHooks: false },
    );
    tui.start();
    try {
      await settleApp(tui);
      const screens: [Screen, string | undefined][] = [
        [issueScreen(session, tui.ctx, local(session, game), issueNo), undefined],
        [pullScreen(session, tui.ctx, local(session, game), pullNo), undefined],
        // The repository's description is on its About card, under `I`.
        [repoScreen(session, tui.ctx, local(session, game)), "I"],
      ];
      for (const [screen, press] of screens) {
        tui.push(screen);
        await settleApp(tui);
        if (press !== undefined) {
          tui.dispatch({ type: "key", key: press, ctrl: false, alt: false, shift: false });
          await settleApp(tui);
        }
        const text = tui.screen.toText();
        // A terminal has no markup: the words are shown as they were said.
        expect(text).toContain("<img src=x onerror=alert(1)>");
        expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f]/);
        if (press !== undefined) tui.pop();
        tui.pop();
        await settleApp(tui);
      }
    } finally {
      tui.stop();
    }
  });

  test("MCP feed and issue cards carry it as data the shell draws with textContent", async () => {
    // `feed` and `issue` both have cards; the hostile text rides as raw data.
    const feed = JSON.parse(await mcp("feed", {})).result;
    const card = feed.structuredContent?.card;
    expect(card).toBeDefined();
    expect(card.rows.map((r: { label: string }) => r.label).join("\n")).toContain(EVIL);
    expect(JSON.stringify(card)).not.toContain("&lt;");
    const issue = JSON.parse(await mcp("issue", { repo: "alice/game", number: issueNo })).result;
    expect(issue.structuredContent.card.title).toContain(EVIL);
    expect(JSON.stringify(issue.structuredContent.card)).not.toContain("&lt;");
    expect(JSON.parse(issue.content[0].text).title).toBe(EVIL);
    const shell = CARD_SHELL("feed");
    expect(shell).not.toContain("innerHTML");
    expect(shell).toContain("textContent");
  });
});
