/**
 * The browsing pages — repo home, commit history, branches — wire up the
 * same live client the issue/pull threads already had, so a push or a new
 * branch shows up as a "new activity" pill without a reload. Verifies the
 * wiring is present on a local repo and absent where there is nothing to
 * subscribe to (an empty repo, or a repo read live off another forge).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableApp } from "../src/actions/apps.ts";
import { editFiles } from "../src/actions/contents.ts";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { withScripts } from "./helpers/page-script.ts";

describe("live browsing pages", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-live-pages-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const user = await createUser(app.db, { origin: "seed", trusted: true,
      username: "lex",
      email: "lex@f.dev",
      password: "live-pages-pass",
    });
    if (!user.ok) throw new Error("user");
    const repo = await createRepo(app.db, app.reposRoot, {
      ownerId: user.value.id,
      name: "proj",
      visibility: "public",
    });
    if (!repo.ok) throw new Error("repo");
    const committed = await editFiles(app, user.value, repo.value, {
      files: [{ path: "README.md", content: "# proj\n" }],
      message: "first commit",
    });
    if (!committed.ok) throw new Error("commit");
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the repo home wires up the live client", async () => {
    const html = await (await fetch(`${base}/lex/proj`)).text();
    expect(html).toContain('id="live"');
    expect(html).toContain('data-repo="/lex/proj"');
    expect(await withScripts(servers.url, html)).toContain("new EventSource");
  });

  test("the commit history wires up the live client", async () => {
    const html = await (await fetch(`${base}/lex/proj/commits`)).text();
    expect(html).toContain('id="live"');
    expect(await withScripts(servers.url, html)).toContain("new EventSource");
  });

  test("the branches page wires up the live client", async () => {
    const html = await (await fetch(`${base}/lex/proj/branches`)).text();
    expect(html).toContain('id="live"');
    expect(await withScripts(servers.url, html)).toContain("new EventSource");
  });

  test("the studio app page wires up the live client with data-app, so a deploy run event refetches the app's own fragment", async () => {
    const user = await createUser(app.db, { origin: "seed", trusted: true,
      username: "nia",
      email: "nia@f.dev",
      password: "live-pages-pass",
      adminIfFirst: true,
    });
    if (!user.ok) throw new Error("user");
    const repo = await createRepo(app.db, app.reposRoot, {
      ownerId: user.value.id,
      name: "runner",
      visibility: "public",
    });
    if (!repo.ok) throw new Error("repo");
    const committed = await editFiles(app, user.value, repo.value, {
      files: [{ path: "README.md", content: "# runner\n" }],
      message: "first commit",
    });
    if (!committed.ok) throw new Error("commit");
    const enabled = await enableApp(app, user.value, repo.value, {
      slug: "runner",
    });
    if (!enabled.ok) throw new Error(String(enabled.error));

    const html = await (
      await fetch(`${base}/nia/runner`, {
        headers: { cookie: "forge_mode=studio" },
      })
    ).text();
    expect(html).toContain('id="live"');
    expect(html).toContain('data-app="1"');
    expect(await withScripts(servers.url, html)).toContain("new EventSource");
    // `app.serving` fires at the swap-in, seconds to half a minute before
    // the deploy run's own `run.finished` — the client must listen for it
    // directly, not only learn a preview is live once its tests are done.
    expect(await withScripts(servers.url, html)).toContain("app.serving");
    // The polite region a swap must speak into — the one place a screen
    // reader learns a preview just went live.
    expect(html).toContain('id="live-status"');
  });

  test("the client script sets the status when the app fragment swaps, not only on the generic New-activity fallback", async () => {
    const { liveClientJs } = await import("../src/web/live.ts");
    // `onEvent` returns straight out of `refreshApp()` for a deploy/serving
    // event (`live.ts`), so it never reaches the fallback branch's
    // `status.textContent = 'New activity on this page'` — the swap itself
    // must set the status, in the same sentence the swapped-in card shows.
    const refreshApp = liveClientJs.slice(
      liveClientJs.indexOf("function refreshApp"),
      liveClientJs.indexOf("function onEvent"),
    );
    expect(refreshApp).toContain("status.textContent");
    // A fragment identical to what's already on screen must not announce
    // anything: the sentence is built from what changed, not fetched anew
    // every time.
    expect(refreshApp).toContain("announceSwap");
  });

  test("the studio home wires up apps and now as live regions (the asks are a page of their own), signed in; a signed-out visitor gets neither", async () => {
    const signedOut = await (
      await fetch(`${base}/`, { headers: { cookie: "forge_mode=studio" } })
    ).text();
    expect(signedOut).not.toContain('id="live-on-you"');

    const user = await createUser(app.db, { origin: "seed", trusted: true,
      username: "ren",
      email: "ren@f.dev",
      password: "live-pages-pass",
    });
    if (!user.ok) throw new Error("user");
    const cookie = (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "ren",
            password: "live-pages-pass",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;

    const html = await (
      await fetch(`${base}/feed`, {
        headers: { cookie: `${cookie}; forge_mode=studio` },
      })
    ).text();
    expect(html).toContain('id="live-apps"');
    expect(html).not.toContain('id="live-on-you"');
    expect(await withScripts(servers.url, html)).toContain("new EventSource('/events')");
  });

  test("a live region never swaps out from under a card that is mid-decision", async () => {
    const { liveRegionsJs } = await import("../src/web/client.ts");
    expect(liveRegionsJs).toContain("data-busy");
  });

  test("the whole page is refetched at most once per 30 s, however many events arrive", async () => {
    const { liveRegionsJs } = await import("../src/web/client.ts");
    expect(liveRegionsJs).toContain("var PAGE_GAP = 30000;");
    const refresh = liveRegionsJs.slice(liveRegionsJs.indexOf("function refresh("));
    expect(refresh).toContain("src === location.href && last - lastPage < PAGE_GAP");
    expect(refresh.indexOf("PAGE_GAP")).toBeLessThan(refresh.indexOf("pull(src"));
  });

  test("a live region never swaps out from under ticked boxes", async () => {
    const { liveRegionsJs } = await import("../src/web/client.ts");
    expect(liveRegionsJs).toContain("input[type=checkbox]:checked");
    // The guard sits in `swap`, before anything is replaced.
    const swap = liveRegionsJs.slice(liveRegionsJs.indexOf("function swap("));
    expect(swap.indexOf("checkbox]:checked")).toBeGreaterThan(-1);
    expect(swap.indexOf("checkbox]:checked")).toBeLessThan(swap.indexOf("innerHTML = "));
  });
});

describe("the beat of a region with data-live-every", () => {
  type Attrs = Record<string, string>;
  const region = (attrs: Attrs, html: string) => {
    const r = {
      id: attrs["id"] ?? "",
      attrs: { ...attrs },
      innerHTML: html,
      getAttribute: (n: string) => r.attrs[n] ?? null,
      hasAttribute: (n: string) => n in r.attrs,
      setAttribute: (n: string, v: string) => void (r.attrs[n] = v),
      removeAttribute: (n: string) => void delete r.attrs[n],
      get attributes() {
        return Object.entries(r.attrs).map(([name, value]) => ({ name, value }));
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      contains: () => false,
      dispatchEvent: () => true,
    };
    return r;
  };

  /** Runs the script against a fake page; `answers` are the fragments the server gives, in order. */
  const run = async (js: string, answers: Attrs[]) => {
    const mine = region(
      { id: "live-checks", "data-live": "run.*", "data-live-src": "/x/checks-line", "data-live-every": "5" },
      "running",
    );
    let n = 0;
    let fragment = region({ id: "live-checks" }, "");
    const timers: Array<() => void> = [];
    const intervals = new Map<number, () => void>();
    const cleared: number[] = [];
    let nextId = 1;
    const doc = {
      hidden: false,
      activeElement: null,
      querySelectorAll: (sel: string) =>
        sel === "[data-live-every]"
          ? "data-live-every" in mine.attrs ? [mine] : []
          : sel === "[data-live]" ? [mine] : [],
      getElementById: (id: string) => (id === "live-checks" ? mine : null),
      createElement: () => ({
        set innerHTML(_: string) {},
        content: { querySelector: () => null, getElementById: () => fragment },
      }),
      dispatchEvent: () => true,
      addEventListener: () => {},
    };
    const win = {
      setInterval: (f: () => void) => (intervals.set(nextId, f), nextId++),
      clearInterval: (id: number) => (intervals.delete(id), void cleared.push(id)),
      addEventListener: () => {},
    };
    class ES {
      addEventListener() {}
      close() {}
    }
    const fake = {
      document: doc,
      window: win,
      location: { href: "http://x/page" },
      EventSource: ES,
      CustomEvent: class {},
      DOMParser: class {},
      setTimeout: (f: () => void) => (timers.push(f), 0),
      clearTimeout: () => {},
      fetch: async () => {
        fragment = region(answers[n++] ?? {}, "changed " + n);
        return { status: 200, ok: true, headers: { get: () => null }, text: async () => "" };
      },
    };
    try { new Function(...Object.keys(fake), js)(...Object.values(fake)); } catch (e) { console.log("ERR", e); }
    const beat = async () => {
      for (const f of [...intervals.values()]) f();
      while (timers.length > 0) timers.shift()!();
      await new Promise((r) => setTimeout(r, 0));
    };
    return { mine, intervals, cleared, beat };
  };

  test("a swap without the attribute clears the beat and the region stops asking", async () => {
    const { liveRegionsJs } = await import("../src/web/client.ts");
    const { mine, intervals, cleared, beat } = await run(liveRegionsJs, [{}]);
    expect(intervals.size).toBe(1);
    await beat();
    expect(cleared.length).toBe(1);
    expect(intervals.size).toBe(0);
    expect(mine.hasAttribute("data-live-every")).toBe(false);
  });

  test("a swap that brings the attribute arms one beat, and a repeat does not arm a second", async () => {
    const { liveRegionsJs } = await import("../src/web/client.ts");
    const every = { "data-live-every": "5" };
    const { intervals, cleared, beat } = await run(liveRegionsJs, [every, every]);
    await beat();
    await beat();
    expect(intervals.size).toBe(1);
    expect(cleared.length).toBe(0);
  });
});

describe("the live mount's markup", () => {
  test("the status line is a polite region drawn with §5's .sr-only, and the pill keeps its words and link", async () => {
    const { liveMount } = await import("../src/web/live.ts");
    const out = String(liveMount({ repo: "/a/b" }));
    expect(out).not.toContain('class="live-status"');
    expect(out).toMatch(/<p\s+class="sr-only"\s+id="live-status"\s+role="status"\s+aria-live="polite"/);
    expect(out).toContain('id="live-pill"');
    expect(out).toContain("New activity — refresh");
  });

  test("the pill is §5's attn badge, hidden until news, and the script finds it by id alone", async () => {
    const { liveMount, liveClientJs } = await import("../src/web/live.ts");
    const out = String(liveMount({ repo: "/a/b" }));
    expect(out).toMatch(/<a\s+id="live-pill"\s+class="badge"\s+data-variant="attn"\s+href=""\s+hidden/);
    expect(out).toMatch(/<div class="live-news">\s*<a id="live-pill"/);
    expect(out).not.toMatch(/class="[^"]*\blive-pill\b/);
    expect(liveClientJs).toContain("document.getElementById('live-pill')");
    expect(liveClientJs).not.toMatch(/\.live-pill|querySelector\([^)]*live-pill/);
  });
});

describe("the live pill's wrapper", () => {
  test("is out of flow and the badge inside is a 36px target", async () => {
    const { components } = await import("../src/web/style/components.ts");
    const rule = (sel: string) => components.slice(components.indexOf(sel + " {")).split("}")[0];
    expect(rule(".live-news")).toMatch(/position: fixed/);
    expect(rule(".live-news .badge")).toMatch(/min-height: 36px/);
  });
});
