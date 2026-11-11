/** /talk reads like a builder (#11009): calls are readable steps, the pane names the repo, the first paint is quick. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { appendTurn, openConversation } from "../src/core/conversations.ts";
import { createSession } from "../src/core/sessions.ts";
import { repoOf, stepOf } from "../src/core/talk_steps.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Ctx } from "../src/http/context.ts";
import { previewEnv } from "../src/apps/data.ts";
import { frameSources } from "../src/web/layout.ts";
import { talkPane } from "../src/web/pages/talk_preview.ts";
import { originOf } from "../src/actions/talk_workspace.ts";
import { filesOf } from "../src/core/talk_steps.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

let dir: string;
let app: App;
let servers: Servers;
let cookie: string;
let userId: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-talk-steps-"));
  app = createApp({ dataDir: dir, port: 0 });
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "dana", email: "dana@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error("user");
  promote(app.db, u.value);
  userId = u.value.id;
  servers = await serve(app);
  cookie = `forge_session=${createSession(app.db, u.value.id).token}`;
});
afterAll(async () => {
  servers.stop();
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

test("a call becomes a short step, never JSON", () => {
  expect(stepOf('mcp__forge__read_file {"repo":"a/b","path":"src/x.ts"}')?.label).toBe("Read src/x.ts");
  expect(stepOf('mcp__forge__write_file {"repo":"a/b","path":"src/x.ts","content":"a\\nb\\nc\\n"}')?.label).toBe("Edited src/x.ts (+3)");
  expect(stepOf('mcp__forge__pull {"repo":"a/b","number":12}')?.label).toBe("Opened pull #12");
  expect(stepOf('mcp__forge__merge {"repo":"a/b","number":12,"dryRun":true}')?.label).toBe("Checked that pull #12 can merge");
  expect(stepOf('mcp__forge__merge {"repo":"a/b","number":12}')?.label).toBe("Merged pull #12 and deployed");
  expect(stepOf("mcp__forge__list_issues {cut")?.label).toBe("List issues");
  expect(stepOf('{"thinking":"x"}')).toBeUndefined();
  expect(stepOf('mcp__forge__pull {"repo":"a/b","number":12}')?.details).toEqual(["repo: a/b", "number: 12"]);
});

test("the repository is the last good one a call named", () => {
  expect(repoOf([{ role: "tool", text: 'x {"repo":"a/b"}' }, { role: "tool", text: 'x {"repo":"../evil"}' }])).toBe("a/b");
  expect(repoOf([{ role: "person", text: "hi" }])).toBeUndefined();
});

test("/talk is two panes, steps are escaped and closed", async () => {
  const c = openConversation(app.db, userId);
  appendTurn(app.db, userId, c.id, { role: "person", text: "build it" });
  appendTurn(app.db, userId, c.id, { role: "tool", text: 'mcp__forge__read_file {"repo":"dana/none","path":"<b>x</b>.ts"}' });
  appendTurn(app.db, userId, c.id, { role: "agent", text: "Done." });
  await fetch(`${servers.url}/talk`, { headers: { cookie } });
  const res = await fetch(`${servers.url}/talk`, { headers: { cookie } });
  const page = await res.text();
  expect(page).toContain("data-shell");
  expect(page).not.toContain("role=\"tab\"");
  expect(page).toContain('href="?pane=preview"');
  expect(page).toContain("Read &lt;b&gt;");
  expect(page).not.toContain("mcp__forge__read_file");
  expect(page).not.toMatch(/<details open/);
  expect(page).toContain("Not a repository you can see");
});

test("the phone's Chat and Preview are links the server draws: ?pane= picks which shows", async () => {
  const get = async (q: string) => (await fetch(`${servers.url}/talk${q}`, { headers: { cookie } })).text();
  expect(await get("")).toContain('data-pane="chat"');
  expect(await get("?pane=preview")).toContain('data-pane="preview"');
  expect(await get("?pane=code")).toContain('data-pane="code"');
  expect(await get("?pane=bogus")).toContain('data-pane="chat"');
});

describe("a repository the person can read", () => {
  let ctx: Ctx;
  let user: User;
  beforeAll(async () => {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username: "erin", email: "erin@forge.local", password: "a-good-passphrase" });
    if (!u.ok) throw new Error("user");
    promote(app.db, u.value);
    user = u.value;
    const made = await createRepo(app, user, { name: "site", visibility: "public" });
    if (!made.ok) throw new Error(made.error);
    ctx = { app } as Ctx;
  });
  const works = new Map([["1", { steps: "", links: [{ href: "/erin/site/blob/main/a.ts", label: "a.ts" }, { href: "/erin/site/pulls/3", label: "#3" }] }]]) as any;
  const apps = (pull: number | undefined, urls: Record<string, string>) => ({ newestPull: () => pull, urlOf: (_: unknown, env: string) => urls[env] });

  test("the preview is the newest pull's environment, and its origin alone goes in frame-src", () => {
    const pane = talkPane(ctx, user, "erin/site", works, "preview", apps(7, { [previewEnv(7)]: "https://lab--7--site.example.test/", production: "https://site.example.test/" }));
    expect(pane.html.text).toContain('<iframe class="talk-frame" data-frame src="https://lab--7--site.example.test/"');
    expect(pane.html.text).toContain("Pull #7");
    expect(pane.frame).toBe("https://lab--7--site.example.test");
    expect(frameSources({ frameSrc: pane.frame })).toContain("https://lab--7--site.example.test");
    expect(frameSources({ frameSrc: pane.frame })).not.toContain("site.example.test/");
  });

  test("with no open pull the preview is production", () => {
    const pane = talkPane(ctx, user, "erin/site", works, "preview", apps(undefined, { production: "https://site.example.test/" }));
    expect(pane.html.text).toContain('src="https://site.example.test/"');
    expect(pane.html.text).toContain("Production");
  });

  test("nothing running draws no frame and no frame-src", () => {
    const pane = talkPane(ctx, user, "erin/site", works, "preview", apps(undefined, {}));
    expect(pane.html.text).not.toContain("<iframe");
    expect(pane.frame).toBeUndefined();
  });

  test("Code lists the files the chat touched and Diff links the pull, both without script", () => {
    const code = talkPane(ctx, user, "erin/site", works, "code", apps(7, {}));
    expect(code.html.text).toContain('<a href="/erin/site/blob/main/a.ts">a.ts</a>');
    expect(code.html.text).not.toContain("pulls/3");
    expect(code.html.text).not.toContain("<iframe");
    expect(code.html.text).toContain('<a href="?pane=code" aria-current="page">Code</a>');
    const diff = talkPane(ctx, user, "erin/site", works, "diff", apps(7, {}));
    expect(diff.html.text).toContain('href="/erin/site/pulls/7/files"');
    expect(talkPane(ctx, user, "erin/site", works, "diff", apps(undefined, {})).html.text).toContain("No open pull yet.");
    for (const p of [code, diff]) expect(p.html.text).not.toContain("hidden");
  });
});

test("an origin is scheme, host and port: userinfo, other schemes and junk name none", () => {
  expect(originOf("https://lab--7--site.example.test/x?y")).toBe("https://lab--7--site.example.test");
  expect(originOf("http://localhost:8080/")).toBe("http://localhost:8080");
  expect(originOf("https://a.com@evil.com/")).toBeUndefined();
  expect(originOf("https://a.com:1@evil.com/")).toBeUndefined();
  expect(originOf("javascript:alert(1)")).toBeUndefined();
  expect(originOf("https://a.com\\@evil.com/")).toBeUndefined();
});

test("the files a chat touched are its reads and edits on that repository, newest first, each once", () => {
  const t = (repo: string, path: string, tool = "read_file") => ({ role: "tool", text: `mcp__forge__${tool} ${JSON.stringify({ repo, path })}` });
  expect(filesOf([t("a/b", "x.ts"), t("a/b", "y.ts", "write_file"), t("a/b", "x.ts"), t("c/d", "z.ts"), t("a/b", "../etc/passwd"), t("a/b", "/abs")], "a/b")).toEqual(["x.ts", "y.ts"]);
});

describe("through the real page", () => {
  let ownCookie: string;
  let strangerCookie: string;
  beforeAll(async () => {
    const mk = async (username: string) => {
      const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase" });
      if (!u.ok) throw new Error("user");
      promote(app.db, u.value);
      return u.value;
    };
    const owner = await mk("fay");
    const stranger = await mk("gus");
    for (const [name, visibility] of [["secret", "private"], ["open", "public"]] as const) {
      const made = await createRepo(app, owner, { name, visibility });
      if (!made.ok) throw new Error(made.error);
    }
    const said = (u: User, repo: string) => {
      const c = openConversation(app.db, u.id);
      appendTurn(app.db, u.id, c.id, { role: "tool", text: `mcp__forge__read_file {"repo":"${repo}","path":"src/a.ts"}` });
    };
    said(stranger, "fay/secret");
    said(owner, "fay/open");
    ownCookie = `forge_session=${createSession(app.db, owner.id).token}`;
    strangerCookie = `forge_session=${createSession(app.db, stranger.id).token}`;
  });

  test("a private repository the viewer cannot read gives no frame, no frame-src and nothing of it", async () => {
    for (const q of ["", "?pane=preview", "?pane=code", "?pane=diff"]) {
      const res = await fetch(`${servers.url}/talk${q}`, { headers: { cookie: strangerCookie } });
      const page = await res.text();
      expect(page).toContain("Not a repository you can see.");
      expect(page).not.toContain("<iframe");
      expect(page).not.toContain("fay/secret</strong>");
      expect(page).not.toContain('href="?pane=code"');
      expect(res.headers.get("content-security-policy") ?? "").not.toMatch(/frame-src [^;]*https?:/);
    }
  });

  test("Code and Diff on a readable repository are drawn by the server, the head said once", async () => {
    const get = async (q: string) => (await fetch(`${servers.url}/talk${q}`, { headers: { cookie: ownCookie } })).text();
    const code = await get("?pane=code");
    expect(code).toContain('<a href="?pane=code" aria-current="page">Code</a>');
    expect(code).toMatch(/No files touched yet\.|src\/a\.ts/);
    expect(code.split("fay/open</strong>").length).toBe(2);
    const diff = await get("?pane=diff");
    expect(diff).toContain('<a href="?pane=diff" aria-current="page">Diff</a>');
    expect(diff).toContain("No open pull yet.");
    expect(await get("?pane=preview")).toContain("Nothing running yet.");
  });
});
