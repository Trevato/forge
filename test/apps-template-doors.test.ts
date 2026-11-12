/**
 * Every door that can name a template: the page (`/apps/new?template=`), the
 * API field, the MCP tool and the terminal's palette entry. Each copies the
 * tip of a readable repository and refuses one that is not, in the words of
 * `TEMPLATE_ERRORS`.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { setRole } from "../src/actions/roles.ts";
import { TEMPLATE_ERRORS } from "../src/apps/template_tip.ts";
import { createApp, type App } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import { blank } from "../src/tui/screens/common.ts";
import { templateAppScreen } from "../src/tui/screens/newapp.ts";
import { deriveAppName } from "../src/web/pages/apps-name.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { tokenFor } from "./helpers/tokens.ts";

quietLogs();
setDefaultTimeout(30_000);

let dir: string;
let app: App;
let servers: Servers;
let base: string;
let giver: User;
let cookie: string;
let token: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tpl-doors-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  base = servers.url;
  const mk = async (username: string, adminIfFirst = false) => {
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@x.test`,
      password: "a-good-passphrase", adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  giver = await mk("giver", true);
  const taker = await mk("taker");
  setRole(app, giver, taker.username, "member");
  for (const [name, visibility] of [["kit", "public"], ["secret", "private"]] as const) {
    const repo = await createRepo(app, giver, { name, visibility, description: "" });
    if (!repo.ok) throw new Error(repo.error);
    const done = await commitToBranch(app, giver, repo.value, {
      message: "t",
      files: [{ path: "README.md", content: `# ${name}\n` }],
    });
    if (!done.ok) throw new Error(String(done.error));
  }
  cookie = (
    (
      await fetch(`${base}/signin`, {
        method: "POST",
        body: new URLSearchParams({ username: "taker", password: "a-good-passphrase" }),
        redirect: "manual",
      })
    ).headers.get("set-cookie") ?? ""
  ).split(";")[0]!;
  token = tokenFor(app, "taker", "rw");
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const readme = (owner: string, name: string): string => {
  const repo = getRepo(app.db, owner, name)!;
  return Bun.spawnSync(["git", "show", `refs/heads/${repo.defaultBranch}:README.md`], {
    cwd: join(app.reposRoot, owner, `${name}.git`),
  }).stdout.toString();
};

test("the page carries ?template= as a read-only field, escaped, and the POST makes the copy", async () => {
  const shown = await (await fetch(`${base}/apps/new?template=giver/kit`, { headers: { cookie } })).text();
  expect(shown).toMatch(/<input[^>]*name="template"[^>]*readonly[^>]*value="giver\/kit"|<input[^>]*name="template"[^>]*value="giver\/kit"[^>]*readonly/s);
  const hostile = await (await fetch(`${base}/apps/new?template=${encodeURIComponent('"><script>x</script>')}`, { headers: { cookie } })).text();
  expect(hostile).not.toContain("<script>x</script>");
  expect(hostile).toContain("&lt;script&gt;");
  const plain = await (await fetch(`${base}/apps/new`, { headers: { cookie } })).text();
  expect(plain).not.toContain('name="template"');

  const posted = await fetch(`${base}/apps/new`, {
    method: "POST",
    headers: { cookie, origin: base },
    body: new URLSearchParams({
      owner: "", name: "from-page", description: "x", visibility: "private", agent: "", template: "giver/kit",
    }),
    redirect: "manual",
  });
  expect(posted.status).toBe(303);
  expect(readme("taker", "from-page")).toBe("# kit\n");
});

test("the page refuses a template it cannot read, in words, and makes nothing", async () => {
  const posted = await fetch(`${base}/apps/new`, {
    method: "POST",
    headers: { cookie, origin: base },
    body: new URLSearchParams({
      owner: "", name: "from-page-2", description: "x", visibility: "private", agent: "", template: "giver/secret",
    }),
    redirect: "manual",
  });
  expect(getRepo(app.db, "taker", "from-page-2")).toBeUndefined();
  const body = posted.status === 303 ? "" : await posted.text();
  expect(posted.status === 303 ? posted.headers.get("location") : body).not.toBe("/taker/from-page-2");
  if (body) expect(body).toContain(TEMPLATE_ERRORS.no_such_template);
});

test("the API field copies a readable template and refuses a private one as missing", async () => {
  const api = (body: unknown) =>
    fetch(`${base}/api/v1/apps`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const ok = await api({ name: "from-api", description: "x", template: "giver/kit" });
  expect(ok.status).toBe(201);
  expect(readme("taker", "from-api")).toBe("# kit\n");
  const hidden = await api({ name: "from-api-2", description: "x", template: "giver/secret" });
  const absent = await api({ name: "from-api-2", description: "x", template: "giver/none" });
  expect(hidden.status).toBeGreaterThanOrEqual(400);
  expect(hidden.status).toBe(absent.status);
  expect(await hidden.json()).toEqual(await absent.json());
  expect(getRepo(app.db, "taker", "from-api-2")).toBeUndefined();
});

test("the MCP tool copies the template and maps a refusal to its words", async () => {
  const call = async (args: unknown) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "new_app", arguments: args } }),
    });
    const body = (await res.json()) as any;
    return { error: body.result.isError === true, text: body.result.content[0].text as string };
  };
  const made = await call({ name: "from-mcp", description: "x", template: "giver/kit" });
  expect(made.error).toBe(false);
  expect(readme("taker", "from-mcp")).toBe("# kit\n");
  const refused = await call({ name: "from-mcp-2", description: "x", template: "giver/secret" });
  expect(refused.error).toBe(true);
  expect(refused.text).toContain(TEMPLATE_ERRORS.no_such_template);
  expect(getRepo(app.db, "taker", "from-mcp-2")).toBeUndefined();
});

test("the terminal offers the template entry to a person, not an agent or a guest, and makes the copy", async () => {
  const identity = (user?: User) => ({
    sshUsername: user?.username ?? "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user,
  });
  const taker = getUserByName(app.db, "taker")!;
  const ids = (u?: User) => forgeCommands(new Session(app, identity(u)))({} as never).map((c) => c.id);
  expect(ids(taker)).toContain("new-app-template");
  expect(ids({ ...taker, kind: "agent" })).not.toContain("new-app-template");
  expect(ids()).not.toContain("new-app-template");

  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(app, identity(taker), { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(templateAppScreen(session, tui.ctx, blank("New app")));
  try {
    const feed = async (s: string) => {
      terminal.feed(s);
      await settleApp(tui);
    };
    await settleApp(tui);
    await feed("nonsense\r");
    expect(tui.screen.toText()).toContain("Name it owner/name.");
    for (let i = 0; i < "nonsense".length; i++) await feed("\x7f");
    await feed("giver/kit\r");
    await feed("a copy from the terminal\r");
    const named = deriveAppName("a copy from the terminal")!;
    const deadline = Date.now() + 8000;
    while (getRepo(app.db, "taker", named) === undefined && Date.now() < deadline) await Bun.sleep(20);
    expect(readme("taker", named)).toBe("# kit\n");
  } finally {
    tui.stop();
  }
});
