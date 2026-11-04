/**
 * Migrate says when a GitHub token sees public repositories only (#7516).
 * The owner connected a classic token without `repo`, saw 62 public rows
 * and no private one, and thought the forge was broken. Here a fake GitHub
 * answers with the scopes a classic token sends (or none, as a fine-grained
 * one does): the card names the limit, links GitHub's new-token page, and
 * takes the new token in place — same origin, rows listed again. The
 * picker's filter narrows as you type, and has a button.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { connectOrigin, connectRefusal, listRemoteRepos } from "../src/actions/origins.ts";
import { listOrigins } from "../src/core/origins.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { GitHubProvider } from "../src/origins/providers/github.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import { PUBLIC_ONLY, newTokenUrl } from "../src/origins/token-reach.ts";
import { html } from "../src/web/html.ts";
import { staticCredential } from "../src/origins/types.ts";
import { migrateJs } from "../src/web/pages/migrate.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { newFakeState, serveFakeForge } from "./fake-origin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let base: string;
let alice: User;
let bob: User;
let carol: User;
let cookie: string;
let bobCookie: string;
/** The line as the page draws it: escaped like every other text. */
const publicOnly = html`${PUBLIC_ONLY}`.text;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-reach-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  base = `http://127.0.0.1:${servers.port}`;
  const person = async (username: string, adminIfFirst = false) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.test`,
      adminIfFirst,
    });
    if (!made.ok) throw new Error(String(made.error));
    promote(app.db, made.value);
    return made.value;
  };
  alice = await person("alice", true);
  bob = await person("bob");
  carol = await person("carol");
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  bobCookie = `forge_session=${createSession(app.db, bob.id).token}`;
});

afterAll(async () => {
  servers.stop();
  forgetProviders(dataDir);
  await rm(dataDir, { recursive: true, force: true });
});

const get = async (path: string): Promise<string> =>
  (await fetch(`${base}${path}`, { headers: { cookie } })).text();

const post = (
  path: string,
  form: Record<string, string>,
  as = cookie,
): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { cookie: as, origin: new URL(base).origin },
    body: new URLSearchParams(form),
    redirect: "manual",
  });

/** The page a form's 303 lands on, with the flash cookie it set. */
async function landing(answer: Response, as = cookie): Promise<string> {
  expect(answer.status).toBe(303);
  const flash = answer.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const to = answer.headers.get("location")!;
  return (
    await fetch(`${base}${to}`, { headers: { cookie: `${as}; ${flash}` } })
  ).text();
}

const repo = (id: number, fullName: string, isPrivate = false) => ({
  id,
  fullName,
  description: `about ${fullName}`,
  cloneUrl: `https://example.invalid/${fullName}.git`,
  private: isPrivate,
});

test("a classic token without `repo` says public only and links the new-token page; one with `repo` does not", async () => {
  const state = newFakeState("github", "trevato", "public-only-token");
  state.scopes = "public_repo, read:org";
  state.repos.push(repo(1, "trevato/ESPO"), repo(2, "trevato/garden"));
  const github = serveFakeForge(state);
  try {
    const connected = await connectOrigin(app, alice, {
      host: github.url,
      kind: "github",
      token: "public-only-token",
    });
    if (!connected.ok) throw new Error(connectRefusal(connected.error).code);
    const originId = connected.value.id;

    const page = await get("/migrate");
    expect(page).toContain(publicOnly);
    expect(page).toContain('data-reach="public"');
    expect(page).toContain(
      `href="${newTokenUrl(github.url).replaceAll("&", "&amp;")}"`,
    );
    expect(page).toContain("/settings/tokens/new?scopes=repo&amp;description=forge-migrate");
    expect(page).toContain("Repository access: All repositories; Contents: Read");
    expect(page).toContain(`action="/settings/origins/${originId}/token"`);
    expect(page).not.toContain("trevato/secret");

    // A wrong token is refused in words, and the origin stays as it was.
    const refused = await post(`/settings/origins/${originId}/token`, {
      token: "not-a-token",
      then: "migrate",
    });
    expect(refused.headers.get("location")).toStartWith("/migrate");
    const refusedPage = await landing(refused);
    expect(refusedPage).toContain("That token was refused by the origin.");
    expect(refusedPage).toContain(publicOnly);

    // A token for another account is refused; the stored one still lists.
    state.login = "someone-else";
    state.token = "other-account-token";
    const other = await landing(
      await post(`/settings/origins/${originId}/token`, {
        token: "other-account-token",
        then: "migrate",
      }),
    );
    expect(other).toContain("That token belongs to another account.");
    state.login = "trevato";
    state.token = "public-only-token";
    const still = await listRemoteRepos(app, alice, originId, true);
    expect(still.ok && still.value.map((r) => r.fullName).sort()).toEqual([
      "trevato/ESPO",
      "trevato/garden",
    ]);

    // Somebody else cannot name alice's origin at all.
    const stranger = await landing(
      await post(
        `/settings/origins/${originId}/token`,
        { token: "public-only-token", then: "migrate" },
        bobCookie,
      ),
      bobCookie,
    );
    expect(stranger).toContain("No such origin.");
    expect((await listRemoteRepos(app, alice, originId, true)).ok).toBe(true);
    expect(listOrigins(app.db, bob.id)).toEqual([]);

    // The new token sees private repositories: the same origin, re-listed.
    state.token = "repo-token";
    state.scopes = "repo, read:org";
    state.repos.push(repo(3, "trevato/secret", true));
    const replaced = await post(`/settings/origins/${originId}/token`, {
      token: "repo-token",
      then: "migrate",
    });
    expect(replaced.status).toBe(303);
    expect(replaced.headers.get("location")).toStartWith("/migrate");
    const origins = listOrigins(app.db, alice.id);
    expect(origins.map((o) => o.id)).toEqual([originId]);

    const after = await get("/migrate");
    expect(after).not.toContain(publicOnly);
    expect(after).not.toContain("data-reach");
    expect(after).toContain("trevato/secret");
    expect(after).toContain("3 repositories");
  } finally {
    github.stop();
  }
});

test("a fine-grained token names no scopes: one private row is the answer", async () => {
  const state = newFakeState("github", "mona", "fine-grained");
  state.repos.push(repo(1, "mona/open"));
  const github = serveFakeForge(state);
  try {
    const provider = new GitHubProvider(
      staticCredential({
        kind: "github",
        apiUrl: github.url,
        webUrl: github.url,
        token: "fine-grained",
      }),
    );
    expect(await provider.tokenReach()).toEqual({ ok: true, value: "public" });
    state.repos.push(repo(2, "mona/closed", true));
    expect(await provider.tokenReach()).toEqual({ ok: true, value: "private" });
  } finally {
    github.stop();
  }
});

test("the filter: a visible button submits the search form; Enter's answer is the server's filter", async () => {
  const page = await get("/migrate");
  expect(page).toMatch(
    /<button[^>]*type="submit"[^>]*form="migrate-search"[^>]*>[\s\S]*?Filter\s*<\/button>|<button[^>]*form="migrate-search"[^>]*type="submit"[^>]*>[\s\S]*?Filter\s*<\/button>/,
  );
  expect(page).toContain('<form method="get" action="/migrate" id="migrate-search">');
  const filtered = await get("/migrate?q=ESPO");
  expect(filtered).toContain("trevato/ESPO");
  expect(filtered).not.toContain('<span class="mono">trevato/garden</span>');
});

/** Just enough DOM for `migrateJs`: the filter field and the picker's rows. */
function fakeDom(names: readonly string[]) {
  const listeners: Record<string, (() => void)[]> = {};
  const q = {
    value: "",
    addEventListener: (kind: string, fn: () => void) => {
      (listeners[kind] ??= []).push(fn);
    },
  };
  const rows = names.map((name) => ({
    name,
    hidden: false,
    getAttribute: (attr: string) =>
      attr === "data-q" ? `${name} about ${name}`.toLowerCase() : null,
  }));
  const document = {
    getElementById: (id: string) => (id === "f-q" ? q : null),
    querySelectorAll: (selector: string) =>
      selector === "[data-pick-rows] [data-q]" ? rows : [],
  };
  const type = (text: string) => {
    q.value = text;
    for (const fn of listeners.input ?? []) fn();
  };
  return { document, rows, type };
}

test("typing ESPO hides the other rows, and clearing it shows them again", () => {
  const dom = fakeDom(["trevato/ESPO", "trevato/garden", "trevato/espo-docs"]);
  new Function("document", migrateJs)(dom.document);
  dom.type("ESPO");
  expect(dom.rows.filter((r) => !r.hidden).map((r) => r.name)).toEqual([
    "trevato/ESPO",
    "trevato/espo-docs",
  ]);
  dom.type("");
  expect(dom.rows.every((r) => !r.hidden)).toBe(true);
});

test("the terminal's migrate screen says public only, names the new-token page, and t replaces the token in place", async () => {
  const state = newFakeState("github", "carol-gh", "carol-public");
  state.scopes = "public_repo";
  state.repos.push(repo(1, "carol-gh/open"));
  const github = serveFakeForge(state);
  const terminal = headlessTerminal(140, 40);
  const { app: tui } = createForgeApp(
    app,
    {
      sshUsername: carol.username,
      remoteAddress: "127.0.0.1",
      fingerprint: "SHA256:test",
      user: carol,
    },
    { terminal, exitHooks: false },
  );
  try {
    const connected = await connectOrigin(app, carol, {
      host: github.url,
      kind: "github",
      token: "carol-public",
    });
    if (!connected.ok) throw new Error(connectRefusal(connected.error).code);
    tui.start();
    await settleApp(tui);
    terminal.feed("M");
    await settleApp(tui);
    const screen = tui.screen.toText();
    expect(screen).toContain("carol-gh/open");
    expect(screen).toContain(PUBLIC_ONLY);
    expect(screen).toContain("/settings/tokens/new?scopes=repo&description=forge-migrate");

    state.token = "carol-repo";
    state.scopes = "repo";
    state.repos.push(repo(2, "carol-gh/closed", true));
    terminal.feed("t");
    await settleApp(tui);
    expect(tui.screen.toText()).toContain("Replace the token for carol-gh");
    terminal.feed("carol-repo");
    terminal.feed("\r");
    const end = Date.now() + 10_000;
    while (!tui.screen.toText().includes("carol-gh/closed") && Date.now() < end) {
      await settleApp(tui);
      await Bun.sleep(25);
    }
    if (!tui.screen.toText().includes("carol-gh/closed")) throw new Error(`never came: still waiting while !tui.screen.toText().includes("carol-gh/closed")`);
    const after = tui.screen.toText();
    expect(after).toContain("carol-gh/closed");
    expect(after).not.toContain(PUBLIC_ONLY);
    expect(listOrigins(app.db, carol.id).map((o) => o.id)).toEqual([
      connected.value.id,
    ]);
  } finally {
    tui.stop?.();
    github.stop();
  }
});
