/**
 * The Lost journey (#10385): a person dropped into a preview knows the app,
 * the environment and the pull, and has three exits (home, comment, tell).
 * Served through the app proxy, public and private, member and stranger.
 */

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { signGrant, type AppTarget } from "../src/apps/proxy.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { TOOLBAR_ASSET_PATH, toolbarJs } from "../src/apps/toolbar.ts";
import { getAppByRepo, type AppRecord } from "../src/core/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";
const HTML = "<html><body><h1>hi</h1></body></html>";
const SECRET_TITLE = "Rework the secret billing flow";

describe("lost journey: where you are and three exits", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let backend: ReturnType<typeof Bun.serve>;
  let status: ReturnType<typeof spyOn>;
  let alice: string;
  const apps: Record<string, { record: AppRecord; pull: number }> = {};

  beforeAll(async () => {
    backend = Bun.serve({
      port: 0,
      fetch: () => new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8" } }),
    });
    dataDir = await mkdtemp(join(tmpdir(), "forge-lost-journey-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    await runtime.start();
    status = spyOn(AppsRuntime.prototype, "envStatus").mockImplementation(
      (_app: unknown, env: string) =>
        ({ env, state: "running", port: backend.port, commitOid: "a".repeat(40) }) as EnvStatus,
    );
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
    for (const visibility of ["public", "private"] as const) {
      const made = await newApp(app, u.value, { name: visibility, description: "x", visibility });
      if (!made.ok) throw new Error(String(made.error));
      const record = getAppByRepo(app.db, made.value.repo.id)!;
      const p = createIssue(app.db, { repoId: record.repoId, authorId: alice, title: SECRET_TITLE, kind: "pull" });
      if (!p.ok) throw new Error(p.error);
      apps[visibility] = { record, pull: p.value.number };
    }
  }, 120_000);

  afterAll(async () => {
    status.mockRestore();
    await runtime.stop();
    servers.stop();
    backend.stop(true);
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const cookieFor = (name: string, env: string) => {
    const record = apps[name]!.record;
    return `forge_grant_${record.id.slice(-8)}=${signGrant(dataDir, { app: record, env } as AppTarget, 60_000, Date.now(), {
      id: alice,
      name: "alice",
      role: "admin",
    })}`;
  };
  const ask = (host: string, path: string, cookie?: string) =>
    fetch(`${servers.url}${path}`, {
      headers: { host, accept: "text/html", ...(cookie === undefined ? {} : { cookie }) },
      redirect: "manual",
    });
  const tagOf = (html: string) => /<script src="([^"]+)"([^>]*) defer><\/script>/.exec(html);

  for (const name of ["public", "private"]) {
    for (const preview of [false, true]) {
      test(`${name} app, ${preview ? "preview" : "production"}: member sees app, environment, pull and the exits`, async () => {
        const { pull } = apps[name]!;
        const env = preview ? `pull-${pull}` : "production";
        const host = preview ? `${name}--${pull}.${DOMAIN}` : `${name}.${DOMAIN}`;
        const res = await ask(host, "/", cookieFor(name, env));
        expect(res.status).toBe(200);
        const html = await res.text();
        const tag = tagOf(html);
        expect(tag).not.toBeNull();
        // The single immutable asset, and nothing else injected into the page's flow.
        expect(tag![1]).toBe(TOOLBAR_ASSET_PATH);
        expect(html.replace(tag![0], "")).toBe(HTML);
        expect(tag![2]).toContain(` data-app="${name}"`);
        expect(tag![2]).toContain(` data-env="${env}"`);
        expect(tag![2]).toContain(` data-repo="alice/${name}"`);
        if (preview) {
          expect(tag![2]).toContain(` data-pull="${pull}"`);
          expect(tag![2]).toContain(SECRET_TITLE);
        } else expect(tag![2]).not.toContain("data-pull");

        // Same exits for the member on every app: crew door offers tell on the forge origin.
        const crew = await (await ask(host, "/__forge/crew", cookieFor(name, env))).json();
        expect((crew as { tell?: string }).tell).toBe(`${servers.url}/alice/${name}/tell`);
      });

      test(`${name} app, ${preview ? "preview" : "production"}: a stranger gets none of the pull's text`, async () => {
        const { pull } = apps[name]!;
        const host = preview ? `${name}--${pull}.${DOMAIN}` : `${name}.${DOMAIN}`;
        const res = await ask(host, "/");
        const body = await res.text();
        expect(body).not.toContain(`alice/${name}/tell`);
        // A public pull's title is public; a private app's is the members' alone.
        if (name === "private") {
          expect(body).not.toContain(SECRET_TITLE);
          expect(body).not.toContain('data-repo="alice/private"');
          expect(body).not.toContain('data-state=');
        }
        expect(await (await ask(host, "/__forge/crew")).text()).not.toContain("/tell");
      });
    }
  }

  test("the asset is one immutable script served from the app's own host", async () => {
    const res = await fetch(`${servers.url}${TOOLBAR_ASSET_PATH}`, { headers: { host: `public.${DOMAIN}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(await res.text()).toBe(toolbarJs);
  });

  // ---- Run the served script against a minimal DOM stub and inspect what it builds. ----
  interface El {
    tag: string;
    attrs: Record<string, string>;
    children: El[];
    style: Record<string, string>;
    listeners: Record<string, unknown[]>;
    textContent: string;
    [k: string]: unknown;
  }
  const el = (tag: string): El => ({
    tag,
    attrs: {},
    children: [],
    style: {},
    listeners: {},
    textContent: "",
    setAttribute(k: string, v: string) { this.attrs[k] = v; },
    hasAttribute(k: string) { return k in this.attrs || (k === "href" && Boolean(this.href)); },
    appendChild(c: El) { this.children.push(c); return c; },
    addEventListener(t: string, f: unknown) { (this.listeners[t] ??= []).push(f); },
    attachShadow() { return (this.shadow = el("#shadow")); },
  });
  const walk = (e: El): El[] => [e, ...e.children.flatMap(walk)];
  const unescape = (v: string) =>
    v.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  /** Boot the toolbar exactly as the browser would for the served tag, and let the crew answer land. */
  const boot = async (html: string, crew: object, href: string) => {
    const t = tagOf(html)!;
    const dataset: Record<string, string> = {};
    for (const m of t[0].matchAll(/ data-([a-z]+)="([^"]*)"/g)) dataset[m[1]!] = unescape(m[2]!);
    const bodyChildren: El[] = [];
    const doc = {
      currentScript: { dataset, removeAttribute() {} },
      createElement: (tag: string) => el(tag),
      addEventListener() {},
      body: { appendChild: (c: El) => bodyChildren.push(c) },
    };
    const win: Record<string, unknown> = { innerWidth: 1200, innerHeight: 800 };
    const loc = new URL(href);
    const fetcher = async () => ({ ok: true, json: async () => crew, headers: { get: () => null } });
    new Function("window", "document", "URL", "location", "fetch", toolbarJs)(win, doc, URL, loc, fetcher);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const host = bodyChildren[0]!;
    const built = walk((host as unknown as { shadow: El }).shadow);
    const named = (text: string) => built.find((e) => e.textContent === text);
    return { host, bodyChildren, built, named, dataset };
  };
  const focusable = (e: El | undefined) =>
    e !== undefined && (e.tag === "button" || (e.tag === "a" && typeof e.href === "string" && e.href !== ""));
  const crewOf = async (host: string, cookie?: string) => (await ask(host, "/__forge/crew", cookie)).json() as Promise<object>;

  test("run: the host is one fixed element, the only node added to the body", async () => {
    const { pull } = apps.public!;
    const host = `public--${pull}.${DOMAIN}`;
    const html = await (await ask(host, "/", cookieFor("public", `pull-${pull}`))).text();
    const run = await boot(html, {}, `http://${host}/x`);
    expect(run.bodyChildren).toHaveLength(1);
    expect(run.host.attrs).toEqual({});
    expect(run.host.id).toBe("forge-toolbar");
    expect(run.host.style.cssText).toContain("position:fixed");
    expect(run.host.style.bottom).toBe("12px");
    expect(run.host.style.right).toBe("12px");
    // Nothing is styled with a stylesheet: the script never makes a style element.
    expect(run.built.some((e) => e.tag === "style")).toBe(false);
  });

  test("run: a member's preview builds Home, the pull link, comment and tell, all focusable and on the forge", async () => {
    const { pull } = apps.public!;
    const host = `public--${pull}.${DOMAIN}`;
    const cookie = cookieFor("public", `pull-${pull}`);
    const html = await (await ask(host, "/", cookie)).text();
    const run = await boot(html, await crewOf(host, cookie), `http://${host}/some/page`);
    const origin = new URL(servers.url).origin;

    const home = run.named("Home")!;
    expect(focusable(home)).toBe(true);
    expect(home.href).toBe(`${origin}/`);

    const pullLink = run.named(`preview \u00b7 #${pull}`)!;
    expect(focusable(pullLink)).toBe(true);
    expect(pullLink.href).toBe(`${origin}/alice/public/pulls/${pull}`);

    const comment = run.named("Comment, tell, make it yours")!;
    expect(focusable(comment)).toBe(true);
    const target = new URL(comment.href as string);
    expect(target.origin).toBe(origin);
    expect(target.pathname).toBe("/alice/public/toolbar");
    expect(target.searchParams.get("env")).toBe(`pull-${pull}`);
    expect(target.searchParams.get("page")).toBe(`http://${host}/some/page`);

    const tell = run.named("Tell the crew")!;
    expect(focusable(tell)).toBe(true);
    const tellTarget = new URL(tell.href as string);
    expect(tellTarget.origin).toBe(origin);
    expect(tellTarget.pathname).toBe("/alice/public/tell");
    expect(tellTarget.searchParams.get("pull")).toBe(String(pull));

    // The note box is a real form with a submit button, not a click-only div.
    expect(run.built.some((e) => e.tag === "form" && (e.listeners.submit ?? []).length === 1)).toBe(true);
    expect(focusable(run.built.find((e) => e.tag === "button" && e.type === "submit"))).toBe(true);
  });

  test("run: production shows the environment and no pull link", async () => {
    const host = `public.${DOMAIN}`;
    const cookie = cookieFor("public", "production");
    const html = await (await ask(host, "/", cookie)).text();
    const run = await boot(html, await crewOf(host, cookie), `http://${host}/`);
    expect(run.named("production")).toBeDefined();
    expect(run.built.some((e) => String(e.textContent).startsWith("preview \u00b7"))).toBe(false);
    expect(run.named("Home")!.href).toBe(`${new URL(servers.url).origin}/`);
  });

  test("a stranger on a public preview still learns app, environment and pull, with no tell", async () => {
    const { pull } = apps.public!;
    const host = `public--${pull}.${DOMAIN}`;
    const html = await (await ask(host, "/")).text();
    const tag = tagOf(html)!;
    expect(tag[2]).toContain(' data-app="public"');
    expect(tag[2]).toContain(` data-env="pull-${pull}"`);
    expect(tag[2]).toContain(` data-pull="${pull}"`);
    const run = await boot(html, await crewOf(host), `http://${host}/`);
    expect(run.named(`preview \u00b7 #${pull}`)!.href).toBe(`${new URL(servers.url).origin}/alice/public/pulls/${pull}`);
    expect(run.named("Home")).toBeDefined();
    expect(run.named("Tell the crew")).toBeUndefined();
    // Comment goes to the forge's own page, which asks the stranger to sign in there.
    expect(new URL(run.named("Comment, tell, make it yours")!.href as string).origin).toBe(new URL(servers.url).origin);
  });

  test("a stranger on a private preview is given no toolbar, so no comment, tell or pull link", async () => {
    const { pull } = apps.private!;
    const html = await (await ask(`private--${pull}.${DOMAIN}`, "/")).text();
    expect(tagOf(html)).toBeNull();
    expect(html).not.toContain("/toolbar");
    expect(html).not.toContain("/pulls/");
  });

  test("security: the script has no eval and no dynamic code", () => {
    expect(toolbarJs).not.toMatch(/\beval\s*\(|new Function/);
  });
});
