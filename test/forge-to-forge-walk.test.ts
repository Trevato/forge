import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getOriginById, listOrigins } from "../src/core/origins.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { getUserByName, type User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import { settled } from "../src/origins/jobs.ts";
import { syncsSettled } from "../src/origins/sync.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { proveAll } from "./helpers/verified.ts";

/**
 * The whole walk a person takes to connect a friend's forge, as a browser
 * makes it: two real forges, forms and redirects only. A second run goes
 * through a stand-in for a 0.5.x forge: no `/api/v1/version`, no `/user/repos`.
 */

setDefaultTimeout(120_000);

/** A browser for one person: cookies per origin, redirects by hand, the Origin header a form sends. */
class Browser {
  private readonly jar = new Map<string, Map<string, string>>();
  constructor(seed: Record<string, string> = {}) {
    for (const [origin, cookie] of Object.entries(seed))
      this.jar.set(origin, new Map([cookie.split("=") as [string, string]]));
  }
  private async go(url: URL, init: RequestInit): Promise<Response> {
    const cookies = this.jar.get(url.origin);
    const headers = new Headers(init.headers);
    if (cookies !== undefined)
      headers.set(
        "cookie",
        [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      );
    const response = await fetch(url, { ...init, headers, redirect: "manual" });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const at = pair!.indexOf("=");
      const held = this.jar.get(url.origin) ?? new Map<string, string>();
      held.set(pair!.slice(0, at), pair!.slice(at + 1));
      this.jar.set(url.origin, held);
    }
    return response;
  }
  /** Follow redirects as a browser does, and say where it ended. */
  async walk(
    start: string | URL,
    first?: RequestInit,
  ): Promise<{ url: URL; response: Response; text: string }> {
    let url = new URL(start);
    let response = await this.go(url, first ?? {});
    for (
      let hops = 0;
      hops < 10 && response.status >= 300 && response.status < 400;
      hops++
    ) {
      url = new URL(response.headers.get("location")!, url);
      response = await this.go(url, {});
    }
    return { url, response, text: await response.text() };
  }
  post(
    to: string | URL,
    fields: Record<string, string>,
  ): Promise<{ url: URL; response: Response; text: string }> {
    const url = new URL(to);
    return this.walk(url, {
      method: "POST",
      headers: {
        origin: url.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields),
    });
  }
}

const unescape = (text: string): string =>
  text
    .replaceAll("&amp;", "&")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x3D;", "=");

/** The authorize link the flow page offers, as `href` in the page. */
function continueLink(flowPage: string): string {
  const hrefs = [
    ...flowPage.matchAll(/href="([^"]*\/oauth\/authorize[^"]*)"/g),
  ].map((m) => unescape(m[1]!));
  expect(hrefs.length).toBeGreaterThan(0);
  return hrefs[0]!;
}

/** Every hidden field of the consent form, the person's choice added. */
function consentFields(
  page: string,
  decision: "allow" | "deny",
): Record<string, string> {
  const form =
    /<form method="post" action="\/oauth\/authorize">[\s\S]*?<\/form>/.exec(
      page,
    )?.[0] ?? "";
  expect(form).not.toBe("");
  const fields: Record<string, string> = {
    decision,
    grant: "ro",
    name: "another forge",
    lifetime: "never",
  };
  for (const input of form.matchAll(
    /<input type="hidden" name="([^"]+)" value="([^"]*)"/g,
  ))
    fields[input[1]!] = unescape(input[2]!);
  return fields;
}

async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "bob",
      GIT_AUTHOR_EMAIL: "b@t",
      GIT_COMMITTER_NAME: "bob",
      GIT_COMMITTER_EMAIL: "b@t",
    },
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0)
    throw new Error(
      `git ${args[0]}: ${await new Response(proc.stderr).text()}`,
    );
  return out.trim();
}

/** A stand-in for a 0.5.x forge: the same forge, minus the routes it did not have yet. */
function olderForge(behind: string): { url: string; stop: () => void } {
  const absent = new Set([
    "/api/v1/version",
    "/api/v1/user/repos",
    "/.well-known/nodeinfo",
    "/api/v1/here",
  ]);
  const server = Bun.serve({
    port: 0,
    idleTimeout: 60,
    async fetch(request) {
      const url = new URL(request.url);
      // What 0.5.x reports of itself: a real version, and no commit in the worst case.

      if (url.pathname === "/api/v1/health") return Response.json({ ok: true, version: "0.5.29", commit: null, draining: false });

      if (absent.has(url.pathname))
        return new Response("{}", {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      const headers = new Headers(request.headers);
      headers.set("host", url.host);
      return fetch(`${behind}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        ...(request.body === null ? {} : { body: request.body }),
        redirect: "manual",
        decompress: false,
      } as RequestInit);
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

describe("connecting a friend's forge, from the address to a repository here", () => {
  const dirs: string[] = [];
  let mine: App;
  let friend: App;
  let mineServers: Servers;
  let friendServers: Servers;
  let older: { url: string; stop: () => void };
  let alice: User;
  let carol: User;
  let aliceBrowser: Browser;
  const friendPassword = "bob-login-secret";

  const make = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "forge-walk-"));
    dirs.push(dir);
    return dir;
  };

  beforeAll(async () => {
    friend = createApp({ dataDir: await make(), port: 0 });
    friendServers = await serve(friend);
    await seedAdmin(friend, {
      username: "bob",
      email: "bob@friend.test",
      password: friendPassword,
    });
    proveAll(friend);
    const bob = getUserByName(friend.db, "bob")!;

    // A repository with real history, on the friend's forge.
    const made = await createRepo(friend, bob, {
      name: "widgets",
      visibility: "public",
    });
    if (!made.ok) throw new Error(`no repo: ${String(made.error)}`);
    for (const n of [1, 2, 3]) {
      const done = await commitToBranch(friend, bob, made.value, {
        branch: "main",
        message: `commit ${n}`,
        files: [{ path: "note.txt", content: `line ${n}\n` }],
      });
      if (!done.ok) throw new Error(String(done.error));
    }

    mine = createApp({ dataDir: await make(), port: 0 });
    mineServers = await serve(mine);
    await seedAdmin(mine, {
      username: "alice",
      email: "alice@forge.test",
      password: "alice-login-secret",
    });
    await seedAdmin(mine, {
      username: "carol",
      email: "carol@forge.test",
      password: "carol-login-secret",
    });
    proveAll(mine);
    alice = getUserByName(mine.db, "alice")!;
    carol = getUserByName(mine.db, "carol")!;
    aliceBrowser = new Browser({
      [mineServers.url]: `forge_session=${createSession(mine.db, alice.id).token}`,
    });
    older = olderForge(friendServers.url);
  }, 120_000);

  afterAll(async () => {
    await syncsSettled();
    older.stop();
    mineServers.stop();
    friendServers.stop();
    forgetProviders(mine.config.dataDir);
    mine.close();
    friend.close();
    for (const dir of dirs)
      await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  }, 120_000);

  test("the page offers one address and one sign-in button, and no token talk", async () => {
    const { text } = await aliceBrowser.walk(
      `${mineServers.url}/settings/origins`,
    );
    const path =
      /<details[^>]*connect-forge[\s\S]*?<\/details>/.exec(text)?.[0] ??
      text.split('id="connect-token"')[0]!;
    const forge = path.slice(path.indexOf("connect-forge"));
    expect(forge.match(/<input(?![^>]*type="hidden")/g)?.length).toBe(1);
    expect(forge).toContain("Sign in there");
    expect(forge).not.toMatch(/token/i);
    expect(forge).not.toMatch(/application/i);
  });

  test("an empty address says so, in words", async () => {
    const { response, text } = await aliceBrowser.post(
      `${mineServers.url}/settings/origins/oauth`,
      { host: "" },
    );
    expect(response.status).toBe(422);
    expect(text).toContain("Type the forge&#39;s address first");
  });

  test("a place that is not a forge is told plainly, with no manual registration", async () => {
    const nothing = Bun.serve({
      port: 0,
      fetch: () => new Response("hello", { status: 200 }),
    });
    try {
      const { text, url } = await aliceBrowser.post(
        `${mineServers.url}/settings/origins/oauth`,
        {
          host: `http://127.0.0.1:${nothing.port}`,
        },
      );
      expect(url.search).not.toContain("register=1");
      expect(text).toContain("could not be reached");
    } finally {
      nothing.stop(true);
    }
  });

  test("saying no on the other forge comes back as plain words, and connects nothing", async () => {
    const bobBrowser = new Browser({
      [friendServers.url]: `forge_session=${createSession(friend.db, getUserByName(friend.db, "bob")!.id).token}`,
    });
    const flow = await aliceBrowser.post(
      `${mineServers.url}/settings/origins/oauth`,
      { host: friendServers.url },
    );
    expect(flow.url.pathname).toStartWith("/settings/origins/flows/");
    const link = continueLink(flow.text);
    const consent = await bobBrowser.walk(link);
    const denied = await fetch(`${friendServers.url}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: `forge_session=${createSession(friend.db, getUserByName(friend.db, "bob")!.id).token}`,
        origin: friendServers.url,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(consentFields(consent.text, "deny")),
    });
    const back = denied.headers.get("location")!;
    expect(new URL(back).searchParams.get("error")).toBe("access_denied");
    const landed = await aliceBrowser.walk(back);
    expect(landed.url.pathname).toBe("/settings/origins");
    expect(landed.text).toContain("You said no");
    expect(landed.text).not.toContain("authorization code");
    expect(listOrigins(mine.db, alice.id)).toHaveLength(0);
  });

  test("the callback stays strict: a forged state, a wrong redirect, a wrong verifier", async () => {
    const forged = await aliceBrowser.walk(
      `${mineServers.url}/settings/origins/callback?state=forged&code=x`,
    );
    expect(forged.url.search).toBe("?error=state");
    // Nobody signed in here: the same callback is kept through signing in, its state unspent.
    const signedOut = await new Browser().walk(`${mineServers.url}/settings/origins/callback?state=forged&code=x`);
    expect(signedOut.url.pathname).toBe("/signin");
    expect(signedOut.url.searchParams.get("next")).toBe("/settings/origins/callback?state=forged&code=x");

    const flow = await aliceBrowser.post(
      `${mineServers.url}/settings/origins/oauth`,
      { host: friendServers.url },
    );
    const link = new URL(continueLink(flow.text));
    const bobCookie = `forge_session=${createSession(friend.db, getUserByName(friend.db, "bob")!.id).token}`;

    const elsewhere = new URL(link);
    elsewhere.searchParams.set("redirect_uri", "https://evil.example/cb");
    const refused = await fetch(elsewhere, {
      headers: { cookie: bobCookie },
      redirect: "manual",
    });
    expect(refused.status).toBe(400);

    const consent = await new Browser({ [friendServers.url]: bobCookie }).walk(
      link,
    );
    const allowed = await fetch(`${friendServers.url}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: bobCookie,
        origin: friendServers.url,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(consentFields(consent.text, "allow")),
    });
    const code = new URL(allowed.headers.get("location")!).searchParams.get(
      "code",
    )!;
    const stolen = await fetch(`${friendServers.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: link.searchParams.get("client_id")!,
        redirect_uri: link.searchParams.get("redirect_uri")!,
        code_verifier: "not-the-verifier-not-the-verifier-not-the-verifier",
      }),
    });
    expect(stolen.status).toBe(400);
    expect(listOrigins(mine.db, alice.id)).toHaveLength(0);
  });

  test("signed out on the other forge: it asks who you are, then asks to allow, with the request kept", async () => {
    const flow = await aliceBrowser.post(`${mineServers.url}/settings/origins/oauth`, { host: friendServers.url });
    expect(flow.text).not.toContain("the instance");
    const elsewhere = new Browser();
    const signIn = await elsewhere.walk(continueLink(flow.text));
    expect(signIn.url.pathname).toBe("/signin");
    const consent = await elsewhere.post(signIn.url, { username: "bob", password: friendPassword });
    expect(consent.url.pathname).toBe("/oauth/authorize");
    expect(consent.text).toContain("Allow");
  });

  async function connectThrough(
    browser: Browser,
    site: string,
    start: Record<string, string>,
  ) {
    const flow = await browser.post(
      `${mineServers.url}/settings/origins/oauth`,
      { host: site, ...start },
    );
    expect(flow.url.pathname).toStartWith("/settings/origins/flows/");
    const link = continueLink(flow.text);
    expect(new URL(link).origin).toBe(site);
    const bob = new Browser({
      [site]: `forge_session=${createSession(friend.db, getUserByName(friend.db, "bob")!.id).token}`,
    });
    const consent = await bob.walk(link);
    expect(consent.response.status).toBe(200);
    const answer = await fetch(`${site}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: {
        cookie: `forge_session=${createSession(friend.db, getUserByName(friend.db, "bob")!.id).token}`,
        origin: site,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(consentFields(consent.text, "allow")),
    });
    expect(answer.status).toBe(303);
    return browser.walk(answer.headers.get("location")!);
  }

  async function broughtHistory(
    browser: Browser,
    owner: string,
    jobPage: string,
  ): Promise<string[]> {
    const job = /\/(mirror|bring)\/?([^/]*)\/([^/?]+)$/.exec(
      new URL(jobPage).pathname,
    );
    expect(job).not.toBeNull();
    await settled(new URL(jobPage).pathname.split("/").at(-1)!);
    const seen = await browser.walk(jobPage);
    expect(seen.response.status).toBe(200);
    return (
      await git(
        ["log", "--format=%s", "main"],
        repoDir(mine.reposRoot, owner, "widgets"),
      )
    ).split("\n");
  }

  test("a current forge: connected, its repositories listed, one brought with its history", async () => {
    const back = await connectThrough(aliceBrowser, friendServers.url, {});
    expect(back.url.pathname).toBe("/settings/origins");
    expect(back.url.search).toBe("?connected=1");
    expect(back.text).toContain("Origin connected");
    expect(back.text).toContain("bob");

    const origin = listOrigins(mine.db, alice.id)[0]!;
    expect(origin).toMatchObject({
      login: "bob",
      authKind: "oauth",
      software: "forge",
      needsReauth: false,
    });

    const repos = await aliceBrowser.walk(
      `${mineServers.url}/settings/origins/${origin.id}/repos`,
    );
    expect(repos.response.status).toBe(200);
    expect(repos.text).toContain("bob/widgets");

    const started = await aliceBrowser.post(
      `${mineServers.url}/settings/origins/${origin.id}/mirror`,
      {
        fullName: "bob/widgets",
        name: "",
      },
    );
    expect(started.url.pathname).toContain(
      `/settings/origins/${origin.id}/mirror/`,
    );
    const history = await broughtHistory(
      aliceBrowser,
      "alice",
      started.url.href,
    );
    expect(history).toEqual(["commit 3", "commit 2", "commit 1"]);
  });

  test("a 0.5.x forge, from a /bring link: it signs in, returns to the link, and brings the app", async () => {
    const browser = new Browser({
      [mineServers.url]: `forge_session=${createSession(mine.db, carol.id).token}`,
    });
    const link = `${older.url}/bob/widgets`;
    const asked = await browser.post(`${mineServers.url}/bring`, { link });
    const card = asked.text.slice(asked.text.indexOf('id="bring-connect-card"'));
    const offered = card.slice(0, card.indexOf("<details"));
    expect(offered).toContain("Sign in there");
    expect(offered).not.toMatch(/token/i);

    const back = await connectThrough(browser, older.url, {
      then: "bring",
      link,
    });
    // It carries straight on with the bring the link asked for.
    expect(back.url.pathname).toStartWith("/bring/");

    const origin = listOrigins(mine.db, carol.id)[0]!;
    expect(getOriginById(mine.db, origin.id)).toMatchObject({
      login: "bob",
      software: "forge",
    });
    const repos = await browser.walk(
      `${mineServers.url}/settings/origins/${origin.id}/repos`,
    );
    expect(repos.text).toContain("bob/widgets");

    const history = await broughtHistory(browser, "carol", back.url.href);
    expect(history).toEqual(["commit 3", "commit 2", "commit 1"]);
  });
});
