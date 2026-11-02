/**
 * Tell the crew from the forge pill (#2252): signed in, the pill offers the
 * forge's own tell page; the tell goes through the one `tell()` and carries
 * the page it was said on (and the pull, on a preview); a cross-origin POST
 * is refused; signed out, no action is offered.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { tellLink } from "../src/apps/crew.ts";
import { toolbarJs } from "../src/apps/toolbar.ts";
import { getAppByRepo, type AppRecord } from "../src/core/apps.ts";
import { listIssues, MAX_BODY } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

describe("tell the crew from the pill", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let record: AppRecord;
  let repoId: string;
  let alice: string;
  let auth: Record<string, string>;
  const forge = "http://forge.test";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-pilltell-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    alice = u.value.id;
    proveAll(app);
    const made = await newApp(app, u.value, {
      name: "notes",
      description: "x",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repoId = made.value.repo.id;
    record = getAppByRepo(app.db, repoId)!;
    auth = { authorization: `Bearer ${createToken(app.db, alice, "t", "rw").token}` };
  }, 120_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const post = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
    fetch(`${servers.url}/alice/notes/tell`, {
      method: "POST",
      headers: { ...auth, ...headers },
      body: new URLSearchParams(fields),
      redirect: "manual",
    });
  const told = () => listIssues(app.db, repoId, {}).map((i) => i.body);

  test("signed in, the pill is given the forge's own tell page; signed out, nothing", () => {
    expect(tellLink(app.db, forge, record, alice)).toBe(`${forge}/alice/notes/tell`);
    expect(tellLink(app.db, forge, record, undefined)).toBeUndefined();
    expect(tellLink(app.db, forge, record, "nobody")).toBeUndefined();
  });

  test("the script's link carries the page and, on a preview, the pull, only to the forge's origin", () => {
    // Run the script against a stub DOM and read the link it makes.
    const links: Record<string, any>[] = [];
    const el = (): Record<string, any> => ({
      style: {},
      dataset: {},
      children: [] as unknown[],
      appendChild(c: unknown) { this.children.push(c); },
      setAttribute() {},
      addEventListener() {},
      attachShadow() { return el(); },
    });
    const make = (tag: string) => { const e = el(); e.tag = tag; if (tag === "a") links.push(e); return e; };
    const run = async (dataset: Record<string, string>, tell: unknown, page: string) => {
      links.length = 0;
      const me = { src: "/__forge/toolbar-x.js", dataset: { forge, ...dataset } };
      const doc = {
        currentScript: me,
        createElement: make,
        addEventListener() {},
        body: el(),
      };
      const fn = new Function("window", "document", "fetch", "location", "URL", toolbarJs);
      await new Promise<void>((done) => {
        fn(
          {},
          doc,
          () => ({
            then: (f: (r: unknown) => unknown) => {
              f({ ok: true, json: () => tell });
              return { then: (g: (c: unknown) => void) => { g(tell); setTimeout(done, 0); return { catch() {} }; } };
            },
          }),
          { href: page },
          URL,
        );
      });
      return links.find((l) => l.textContent === "Tell the crew");
    };
    return (async () => {
      const prev = await run({ app: "notes", env: "pull-3", pull: "3" }, { tell: `${forge}/alice/notes/tell` }, "https://notes.apps.test/b?x=1");
      const u = new URL(prev!.href);
      expect(u.origin + u.pathname).toBe(`${forge}/alice/notes/tell`);
      expect(u.searchParams.get("page")).toBe("https://notes.apps.test/b?x=1");
      expect(u.searchParams.get("pull")).toBe("3");
      const prod = await run({ app: "notes", env: "production" }, { tell: `${forge}/alice/notes/tell` }, "https://notes.apps.test/");
      expect(new URL(prod!.href).searchParams.has("pull")).toBe(false);
      expect(new URL(prod!.href).searchParams.get("page")).toBe("https://notes.apps.test/");
      // A link to some other origin is never made; signed out has none.
      expect(await run({ app: "notes" }, { tell: "https://evil.test/alice/notes/tell" }, "https://n/")).toBeUndefined();
      expect(await run({ app: "notes" }, {}, "https://n/")).toBeUndefined();
    })();
  });

  test("the tell page carries the page and the pull into the form", async () => {
    const page = "https://notes.apps.test/list?x=1";
    const res = await fetch(
      `${servers.url}/alice/notes/tell?page=${encodeURIComponent(page)}&pull=7`,
      { headers: auth },
    );
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain(`name="page" value="${page}"`);
    expect(text).toContain('name="pull" value="7"');
    // A page that is not http(s) is dropped, not echoed.
    const bad = await (
      await fetch(`${servers.url}/alice/notes/tell?page=javascript:alert(1)`, { headers: auth })
    ).text();
    expect(bad).not.toContain('name="page"');
  });

  test("a tell from production carries its page, and a receipt links to it", async () => {
    const res = await post({ text: "Make it purple", page: "https://notes.apps.test/a" });
    expect(res.status).toBe(200);
    const html = await res.text();
    const issue = listIssues(app.db, repoId, {}).find((i) => i.title === "Make it purple")!;
    expect(html).toContain(`href="/alice/notes/issues/${issue.number}"`);
    expect(issue.body).toContain("- page: https://notes.apps.test/a");
    expect(issue.body).not.toContain("- pull:");
  });

  test("a tell from a preview carries its page and its pull", async () => {
    const res = await post({
      text: "Bigger button",
      page: "https://notes-pull-3.apps.test/b",
      pull: "3",
    });
    expect(res.status).toBe(200);
    const issue = listIssues(app.db, repoId, {}).find((i) => i.title === "Bigger button")!;
    expect(issue.body).toContain("- page: https://notes-pull-3.apps.test/b");
    expect(issue.body).toContain("- pull: #3");
  });

  test("a bad page or pull opens nothing", async () => {
    const before = told().length;
    expect((await post({ text: "x", page: "javascript:alert(1)" })).status).toBe(303);
    expect((await post({ text: "x", page: "https://a.test/", pull: "-1" })).status).toBe(303);
    expect(told().length).toBe(before);
  });

  test("a refused tell sends the person back with their words, the page and the pull kept", async () => {
    // Over-long: refused by tell(), after the page and pull passed.
    const res = await post({ text: "y".repeat(MAX_BODY + 1), page: "https://notes.apps.test/c", pull: "4" });
    expect(res.status).toBe(303);
    const back = new URL(res.headers.get("location")!, forge);
    expect(back.pathname).toBe("/alice/notes/tell");
    expect(back.searchParams.get("page")).toBe("https://notes.apps.test/c");
    expect(back.searchParams.get("pull")).toBe("4");
    expect(back.searchParams.get("text")!.startsWith("yyy")).toBe(true);
    const form = await (await fetch(`${servers.url}${back.pathname}${back.search}`, { headers: auth })).text();
    expect(form).toContain("yyy");
    expect(form).toContain('name="pull" value="4"');
  });

  test("the tell page renders a pull only with a page", async () => {
    const lone = await (await fetch(`${servers.url}/alice/notes/tell?pull=5`, { headers: auth })).text();
    expect(lone).not.toContain('name="pull"');
  });

  test("the MCP tell carries page and pull, and refuses a bad pull", async () => {
    const call = async (context: unknown) => {
      const res = (await (
        await fetch(`${servers.url}/mcp`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "tell", arguments: { repo: "alice/notes", text: "From mcp", context } },
          }),
        })
      ).json()) as { result: { isError?: boolean } };
      return res.result.isError === true;
    };
    const mcpTold = () => listIssues(app.db, repoId, {}).filter((i) => i.title === "From mcp");
    for (const bad of [0, -1, 1.5, "3"]) {
      expect(await call({ page: "https://notes.apps.test/m", pull: bad })).toBe(true);
    }
    expect(mcpTold().length).toBe(0);
    expect(await call({ page: "https://notes.apps.test/m", pull: 3 })).toBe(false);
    const issue = mcpTold();
    expect(issue.length).toBe(1);
    expect(issue[0]!.body).toContain("- pull: #3");
    expect(issue[0]!.body).toContain("- page: https://notes.apps.test/m");
  });

  test("a cross-origin POST is refused and opens nothing", async () => {
    const before = told().length;
    const res = await post(
      { text: "Sneaky", page: "https://notes.apps.test/" },
      { origin: "https://notes.apps.test" },
    );
    expect(res.status).toBe(403);
    expect(told().length).toBe(before);
  });
});
