/**
 * Apps, runs and the crew, in a browser (docs/APPS.md). Every page here is
 * met the way a person meets it: fetch the page, read the words, post the
 * form, follow the redirect. A real forge with a real `AppsRuntime` behind
 * it, so "New app" really scaffolds a repository and really starts a
 * deploy — the pages are asserted on what they say about that, never on
 * the deploy finishing, which is `test/apps.test.ts`'s job.
 *
 * The adversarial assertions carry the weight: an anonymous visitor gets
 * the one 404 for a private app's pages, a non-admin never sees the crew
 * section, an agent off the crew cannot be assigned, a private app opens
 * only through a grant, and every new POST refuses a cross-origin form.
 */

import { createOrg } from "../src/core/orgs.ts";
import {
  MAX_STARTER_LENGTH,
  STARTERS,
  starterHref,
} from "../src/web/pages/apps-starters.ts";
import { previewLook } from "../src/web/pages/apps.ts";
import type { EnvStatus } from "../src/apps/runtime.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { getAgentByName, listCrew } from "../src/core/agents.ts";
import { listAppEnvNames } from "../src/core/app_env.ts";
import { spanWords } from "../src/apps/golden_path.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { getIssue } from "../src/core/issues.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { isTerminal, listRuns, type Run } from "../src/core/runs.ts";
import { getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { adminCookie } from "./helpers/admin.ts";

quietLogs();

const PASSWORD = "a-long-apps-passphrase";
const DOMAIN = "apps.test";

/** A page with its whitespace collapsed, for asserting on a sentence. */
const words = (html: string): string => html.replace(/\s+/g, " ");

/** The flash a redirect carries, decoded from its cookie. */
const flashOf = (response: Response): string =>
  decodeURIComponent(response.headers.get("set-cookie") ?? "");

describe("apps, runs and the crew on the web", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let base = "";
  let alice = "";
  let bob = "";
  let hello: Repo;

  const web = (
    cookie: string,
    path: string,
    init: RequestInit & { form?: Record<string, string>; origin?: string } = {},
  ): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (cookie !== "") headers.set("cookie", cookie);
    const method = init.form !== undefined ? "POST" : (init.method ?? "GET");
    if (init.form !== undefined)
      headers.set("origin", init.origin ?? new URL(base).origin);
    return fetch(`${base}${path}`, {
      ...init,
      method,
      headers,
      redirect: "manual",
      ...(init.form === undefined
        ? {}
        : { body: new URLSearchParams(init.form) }),
    });
  };

  const bodyOf = async (cookie: string, path: string): Promise<string> => {
    const response = await web(cookie, path);
    expect(`${path} → ${response.status}`).toBe(`${path} → 200`);
    return words(await response.text());
  };

  /** Read from an SSE body until `predicate(buffer)` holds or we time out. */
  const readUntil = async (
    body: ReadableStream<Uint8Array>,
    predicate: (buf: string) => boolean,
    timeoutMs = 10_000,
  ): Promise<string> => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        const timeout = new Promise<{ done: true; value: undefined }>((r) =>
          setTimeout(
            () => r({ done: true, value: undefined }),
            Math.max(0, deadline - Date.now()),
          ),
        );
        const { done, value } = await Promise.race([reader.read(), timeout]);
        if (done) break;
        if (value) buf += decoder.decode(value, { stream: true });
        if (predicate(buf)) break;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    return buf;
  };

  const signUp = async (username: string): Promise<string> => {
    const response = await fetch(`${base}/signup`, {
      method: "POST",
      body: new URLSearchParams({
        username,
        email: `${username}@forge.test`,
        password: PASSWORD,
      }),
      redirect: "manual",
    });
    return `${(response.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=dev`;
  };

  const user = (name: string): User => getUserByName(app.db, name)!;

  /** The runtime reacts to events asynchronously; wait for a run to exist. */
  async function runsOf(
    repo: Repo,
    where: (run: Run) => boolean = () => true,
    timeoutMs = 10_000,
  ): Promise<Run[]> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const runs = listRuns(app.db, repo.id, { limit: 50 }).filter(where);
      if (runs.length > 0) return runs;
      await Bun.sleep(50);
    }
    return [];
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-web-apps-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    runtime = new AppsRuntime(app, {
      domain: DOMAIN,
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    await runtime.start();
    alice = `${await adminCookie(app, { username: "alice", email: "alice@forge.test", password: PASSWORD })}; forge_mode=dev`;
    bob = await signUp("bob");
  }, 30_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  // ---- the golden path's first step ----

  test("New app: the form, and where it sends someone with no crew", async () => {
    const anonymous = await web("", "/apps/new");
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toContain("/signin");

    const html = await bodyOf(alice, "/apps/new");
    expect(html).toContain("What should it do?");
    expect(html).toContain(`.${DOMAIN}`);
    // No agents yet: no select, and the admin is told where to make one.
    expect(html).not.toContain('name="agent"');
    expect(html).toContain("No agents on this forge yet");
    expect(html).toContain('href="/settings/crew"');
    // A non-admin is told an admin can, not handed a link that 404s.
    expect(await bodyOf(bob, "/apps/new")).not.toContain(
      'href="/settings/crew"',
    );
  });

  test("New app: starters are plain links that prefill the box; a hostile description is escaped or ignored", async () => {
    const plain = await (await web(alice, "/apps/new")).text();
    for (const starter of STARTERS)
      expect(plain).toContain(`href="${starterHref(starter)}"`);

    const starter = STARTERS[0]!;
    const filled = await (
      await web(alice, starterHref(starter))
    ).text();
    expect(filled).toMatch(
      new RegExp(`data-grow>\\s*${starter}</textarea\\s*>`),
    );

    const hostile = `</textarea><script>alert(1)</script>"><img src=x onerror=1>`;
    const escaped = await (
      await web(alice, `/apps/new?description=${encodeURIComponent(hostile)}`)
    ).text();
    expect(escaped).not.toContain("<script>alert(1)");
    expect(escaped).not.toContain("<img src=x");
    expect(escaped).toContain("&lt;script&gt;alert(1)");

    for (const bad of ["x".repeat(MAX_STARTER_LENGTH + 1), "a\u0000b", "   "]) {
      const ignored = await (
        await web(alice, `/apps/new?description=${encodeURIComponent(bad)}`)
      ).text();
      expect(ignored).toMatch(/data-grow>\s*<\/textarea\s*>/);
    }
  });

  test("New app: starters keep a valid ?owner= (an org the viewer writes to) and drop an unknown one", async () => {
    const org = createOrg(app.db, "starterorg", user("alice").id);
    if (!org.ok) throw new Error(org.error);
    const starter = STARTERS[1]!;
    const withOrg = await (
      await web(alice, "/apps/new?owner=starterorg")
    ).text();
    for (const s of STARTERS)
      expect(withOrg).toContain(
        `href="${starterHref(s, "starterorg").replace("&", "&amp;")}"`,
      );
    expect(withOrg).toMatch(/<option\s+value="starterorg"\s+selected/);
    const filled = await (
      await web(alice, starterHref(starter, "starterorg"))
    ).text();
    expect(filled).toMatch(/<option\s+value="starterorg"\s+selected/);

    const stranger = await (
      await web(alice, "/apps/new?owner=nobody%22%3E%3Cb%3E")
    ).text();
    expect(stranger).not.toContain("&owner=");
    expect(stranger).not.toContain("<b>");
  });

  test("New app creates the app and lands on its own page, URL in hand", async () => {
    const created = await web(alice, "/apps/new", {
      form: {
        owner: "alice",
        name: "hello",
        description: "",
        visibility: "public",
      },
    });
    expect(created.status).toBe(303);
    expect(created.headers.get("location")).toBe("/alice/hello");
    expect(flashOf(created)).toContain(
      `hello is starting at http://hello.${DOMAIN}:${servers.port}`,
    );
    hello = getRepo(app.db, "alice", "hello")!;
    expect(hello).toBeDefined();
    expect(getAppByRepo(app.db, hello.id)?.slug).toBe("hello");

    // The app page is the repo home for a repository that is an app, in
    // every mode; its Files step, the code, wears the strip with the same
    // URL in a link to open it.
    const home = await bodyOf(alice, "/alice/hello");
    expect(home).toContain('href="/alice/hello/files"');
    const code = await bodyOf(alice, "/alice/hello/files");
    expect(code).toContain('href="/alice/hello/app/production/open"');
    // A plain repository wears neither.
    const plain = await web(alice, "/new", {
      form: { owner: "alice", name: "plain", visibility: "private" },
    });
    expect(plain.status).toBe(303);
    const plainHome = await bodyOf(alice, "/alice/plain");
    expect(plainHome).not.toContain('class="app-strip"');
    expect(plainHome).not.toContain('href="/alice/plain?mode=studio"');
  });

  test("a refused New app keeps what was typed", async () => {
    const dup = await web(alice, "/apps/new", {
      form: { owner: "alice", name: "hello", visibility: "public" },
    });
    expect(dup.status).toBe(422);
    const html = words(await dup.text());
    expect(html).toContain("already has a repository by that name");
    expect(html).toContain('value="hello"');
  });

  test("the dashboard and /apps list the app with its state and URL", async () => {
    // The home's rail names your apps and offers New app (#625).
    const dash = await bodyOf(alice, "/feed");
    expect(dash).toContain("<h2>Your apps</h2>");
    expect(dash).toContain("alice/hello");
    expect(dash).toContain('href="/apps/new"');

    // /apps is the shelf (#630): a row opens the app's page, where its URL
    // and Open live; production's state is the row's own phrase.
    const list = await bodyOf(alice, "/apps");
    expect(list).toContain('href="/alice/hello"');
    expect(list).toContain('class="row"');
    // Signed out, a public app is still listed; the button says sign in.
    const anonymous = await bodyOf("", "/apps");
    expect(anonymous).toContain('href="/alice/hello"');
    expect(anonymous).toContain("Sign in");
  });

  test("the apps list is rows, not a box, and so is the new-app step", async () => {
    const list = await bodyOf(alice, "/apps");
    expect(list).toContain('class="list setting-list"');
    expect(list).not.toMatch(/class="card[ "]/);
    expect(list).toMatch(
      /<div class="page-head">[\s\S]*?<span class="page-head-sub[^"]*">Every app you can reach, and whether it is serving\.<\/span>/,
    );
    const form = await bodyOf(alice, "/apps/new");
    expect(form).toContain('action="/apps/new"');
    expect(form).not.toMatch(/class="card[ "]/);
  });

  test("an empty /apps says so in plain words, with no box", async () => {
    const none = await bodyOf(alice, "/apps?archived=1");
    expect(none).toContain("Nothing is archived");
    expect(none).not.toMatch(/class="card[ "]/);
  });

  test("the preview card is bare when quiet and keeps its tone and box when failed", () => {
    const env = { env: "pull-1", state: "ok" } as unknown as EnvStatus;
    expect(previewLook(env)).toEqual({ extra: "bare env-card" });
    expect(previewLook({ ...env, state: "failed" } as EnvStatus)).toEqual({
      extra: "env-card",
      tone: "danger",
    });
    expect(previewLook({ ...env, error: "boom" } as EnvStatus).tone).toBe("danger");
    expect(
      previewLook({ ...env, failedDeploy: {} } as unknown as EnvStatus),
    ).toEqual({ extra: "env-card", tone: "attn" });
  });

  // ---- the app page and the runs ----

  test("dev's old App URL lands on the studio's app page, which has the environment controls a writer gets", async () => {
    const runs = await runsOf(hello);
    expect(runs.length).toBeGreaterThan(0);
    // The app page is the repo home in every mode, so the old URL lands
    // there directly.
    const old = await web(alice, "/alice/hello/app");
    expect(old.status).toBe(302);
    expect(old.headers.get("location")).toBe("/alice/hello");
    // The code page's strip is the same way back.
    expect(await bodyOf(alice, "/alice/hello/files")).toContain(
      'href="/alice/hello"',
    );
    // (Its Open link waits for production to be running, #118 — the
    // dashboard's test above holds that link; this one, the controls.)
    const html = await bodyOf(alice, "/alice/hello");
    expect(html).toContain('action="/alice/hello/app/production/redeploy"');
    expect(html).toContain('href="/alice/hello/settings/app"');
    // A reader sees no buttons; bob can read the public repo but not write.
    const readers = await bodyOf(bob, "/alice/hello");
    expect(readers).not.toContain("/redeploy");
    expect(readers).not.toContain('href="/alice/hello/settings/app"');
  });

  test("the App page mounts the live stream on a quiet app, so a push after it was drawn still shows up", async () => {
    // Quiet: every run on hello has already finished, nothing is deploying.
    await runsOf(hello, () => true);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const runs = listRuns(app.db, hello.id, { limit: 50 });
      if (runs.every((run) => isTerminal(run.state))) break;
      await Bun.sleep(50);
    }
    const html = await bodyOf(alice, "/alice/hello");
    expect(html).toContain('id="live"');
    expect(html).toContain('data-repo="/alice/hello"');

    // A quiet page still opens the stream: the redeploy fired after the
    // page was drawn reaches it, exactly what a still-page never saw.
    const res = await fetch(`${base}/alice/hello/stream`, {
      headers: { cookie: alice },
    });
    expect(res.status).toBe(200);
    const redeployed = await web(
      alice,
      "/alice/hello/app/production/redeploy",
      { form: {} },
    );
    expect(redeployed.status).toBe(303);
    const buf = await readUntil(
      res.body!,
      (b) =>
        b.includes("event: run.started") || b.includes("event: app.serving"),
    );
    expect(
      buf.includes("event: run.started") || buf.includes("event: app.serving"),
    ).toBe(true);
  }, 20_000);

  test("the app's tabs and doors: no second home key, no App button under the App tab, and telling the crew is offered only to who may", async () => {
    // The palette's studio rows, so a studio browser.
    const studio = (cookie: string) =>
      cookie.replace("forge_mode=dev", "forge_mode=studio");
    const home = await (await web(studio(alice), "/alice/hello")).text();
    // `g h` is the wordmark's go-home key, once; the App tab takes none.
    expect(home.split('data-shortcut="g h"').length - 1).toBe(1);
    expect(home).toContain("— Tell the crew");
    const files = await (await web(alice, "/alice/hello/files")).text();
    expect(files).toContain('class="app-strip"');
    const strip = files.slice(
      files.indexOf('class="app-strip"'),
      files.indexOf("</div>", files.indexOf('class="app-strip"')),
    );
    expect(strip).not.toContain(">App<");
    // The address wears §5's utilities, not a page-local class.
    expect(files).not.toContain("app-url");
    // bob reads the public app but cannot write it; a visitor neither.
    expect(await (await web(studio(bob), "/alice/hello")).text()).not.toContain(
      "— Tell the crew",
    );
    expect(await (await web("", "/alice/hello")).text()).not.toContain(
      "— Tell the crew",
    );
  });

  test("the runs list, one run's log page, and the short door to it", async () => {
    // Every wait here is on the machine, not the code: give each a wide
    // bound so a loaded check lane fails only on a real hang.
    const [run] = await runsOf(hello, () => true, 30_000);
    expect(run).toBeDefined();
    // The live log exists only while it is going, and the page never
    // reloads itself either way (#2873).
    // Match the real <meta> / data-stream= attributes — not the same
    // strings inside studioRunJs (a bare includes("http-equiv=…") stays
    // true after the meta is gone because the script still quotes it).
    const isGoing = (): boolean => {
      const s = listRuns(app.db, hello.id).find((r) => r.id === run!.id)!.state;
      return s === "queued" || s === "running";
    };
    const hasMetaRefresh = (html: string): boolean =>
      /<meta[^>]*http-equiv="refresh"/.test(html);
    // Read the state before and after the render and assert only when they
    // agree: a run that settles mid-render says nothing, so render again.
    // A run only moves forward, so this ends once it is done.
    const deadline = Date.now() + 15_000;
    for (;;) {
      const before = isGoing();
      const html = await bodyOf(alice, `/alice/hello/runs/${run!.id}`);
      const after = isGoing();
      if (before === after) {
        // The tail is live while the run goes: it names its run (read from /events), not a stream.
        expect(html.includes(`data-run="${run!.id}"`)).toBe(before);
        expect(html.includes("data-stream=")).toBe(false);
        expect(hasMetaRefresh(html)).toBe(false);
        break;
      }
      if (Date.now() >= deadline) {
        throw new Error(`run ${run!.id} never held one state across a render`);
      }
    }

    // Let the deploy settle before the list and log are read: a queued run
    // has no log lines yet and moves between the list's words, so those
    // assertions would depend on how loaded the machine is.
    const settleBy = Date.now() + 60_000;
    while (isGoing()) {
      if (Date.now() >= settleBy) {
        throw new Error(`run ${run!.id} never settled`);
      }
      await Bun.sleep(50);
    }
    // One list (#629): the crew's runs by default; the deploys are its
    // `?kind=deploy`, one quiet link under it.
    const crew = await bodyOf(alice, "/alice/hello/runs");
    expect(crew).toContain('href="/alice/hello/runs?kind=deploy"');
    // Whichever word the deploy has reached, it is under one of them.
    const list = (
      await Promise.all(
        ["", "&word=shipped", "&word=stopped"].map((w) =>
          bodyOf(alice, `/alice/hello/runs?kind=${run!.kind}${w}`),
        ),
      )
    ).join("");
    expect(list).toContain("Deploy production");
    expect(list).toContain(`href="/alice/hello/runs/${run!.id}"`);
    expect(await bodyOf(alice, "/alice/hello/runs?kind=agent")).toContain(
      "Nothing open.",
    );

    const page = await bodyOf(alice, `/alice/hello/runs/${run!.id}`);
    expect(page).toContain("<h1>Deploy production</h1>");
    expect(page).toContain('id="run-log"');
    expect(page).toContain('id="run-word"');
    expect(page).not.toContain("issue-head");
    expect(page).not.toContain("issue-meta");
    // The log is drawn line by line, each by what kind of line it is: the
    // forge's own words ("checking out …") are marked as such.
    expect(page).toContain(`data-line="forge"`);
    expect(page).not.toMatch(/class="[^"]*\bln-/);
    expect(page).toContain('id="run-elapsed"');

    const door = await web(alice, `/runs/${run!.id}`);
    expect(door.status).toBe(303);
    expect(door.headers.get("location")).toBe(`/alice/hello/runs/${run!.id}`);
    // Anonymous: sign in first, whatever the id — the redirect says nothing.
    for (const id of [run!.id, "nope"]) {
      const anonymous = await web("", `/runs/${id}`);
      expect(anonymous.status).toBe(303);
      expect(anonymous.headers.get("location")).toContain("/signin");
    }
    expect((await web(alice, "/runs/nope")).status).toBe(404);
    expect((await web(alice, "/alice/hello/runs/nope")).status).toBe(404);
  }, 120_000);

  test("cancelling a run: a writer may, a reader may not", async () => {
    const [run] = await runsOf(hello);
    const refused = await web(bob, `/alice/hello/runs/${run!.id}/cancel`, {
      form: {},
    });
    expect(refused.status).toBe(303);
    expect(flashOf(refused)).toContain("write access");

    const cancelled = await web(alice, `/alice/hello/runs/${run!.id}/cancel`, {
      form: {},
    });
    expect(cancelled.status).toBe(303);
    const after = listRuns(app.db, hello.id).find((r) => r.id === run!.id)!;
    if (after.state === "cancelled")
      expect(flashOf(cancelled)).toContain("Run cancelled");
    else expect(flashOf(cancelled)).toContain("already finished");
  });

  // ---- settings ----

  test("repo settings: require checks toggles, the App section edits how it is served", async () => {
    const general = await bodyOf(alice, "/alice/hello/settings");
    expect(general).toContain('name="requireChecks"');
    const saved = await web(alice, "/alice/hello/settings", {
      form: {
        description: "",
        visibility: "public",
        defaultBranch: hello.defaultBranch,
        requireChecks: "on",
      },
    });
    expect(saved.status).toBe(303);
    hello = getRepo(app.db, "alice", "hello")!;
    expect(hello.requireChecks).toBe(true);

    const section = await bodyOf(alice, "/alice/hello/settings/app");
    expect(section).toContain('name="slug"');
    expect(section).toContain('value="hello"');
    expect(section).toContain("Stop running as an app");
    expect(section).toContain(`hello.${DOMAIN}`);

    const changed = await web(alice, "/alice/hello/settings/app", {
      form: { slug: "hello", access: "private", previewData: "empty" },
    });
    expect(changed.status).toBe(303);
    const record = getAppByRepo(app.db, hello.id)!;
    expect(record.access).toBe("private");
    expect(record.previewData).toBe("empty");

    // Only an admin of the repository sees the section at all.
    expect((await web(bob, "/alice/hello/settings/app")).status).toBe(404);
    // The crew is a card on the one settings page now: bob, who can read
    // but not write, is shown neither the roster nor a form there.
    const bobCrew = await web(bob, "/alice/hello/settings/crew");
    expect(bobCrew.status).toBe(303);
    expect(bobCrew.headers.get("location")).toBe("/alice/hello/settings#crew");
    const bobSettings = await bodyOf(bob, "/alice/hello/settings");
    expect(bobSettings).not.toContain("Add to crew");
    expect(bobSettings).not.toContain('action="/alice/hello/settings');
  });

  test("Open goes straight to a public app and through a grant for a private one", async () => {
    // Private right now, from the test above: a grant for alice.
    const granted = await web(alice, "/alice/hello/app/production/open");
    expect(granted.status).toBe(302);
    expect(granted.headers.get("location")).toStartWith(
      `http://hello.${DOMAIN}:${servers.port}/__forge/grant?t=`,
    );
    // Anonymous visitors have nobody to vouch for them: sign in first.
    const anonymous = await web("", "/alice/hello/app/production/open");
    expect(anonymous.status).toBe(303);
    expect(anonymous.headers.get("location")).toContain("/signin");
    // An environment that is not one is not found.
    expect((await web(alice, "/alice/hello/app/nowhere/open")).status).toBe(
      404,
    );

    const back = await web(alice, "/alice/hello/settings/app", {
      form: { slug: "hello", access: "public", previewData: "copy" },
    });
    expect(back.status).toBe(303);
    const open = await web("", "/alice/hello/app/production/open");
    expect(open.status).toBe(302);
    expect(open.headers.get("location")).toBe(
      `http://hello.${DOMAIN}:${servers.port}`,
    );
  });

  test("Environment: names on the page, values write-only, admin only, same-origin only", async () => {
    const secret = "s3cret-value-for-the-page-7b2e";
    const before = words(
      await (await web(alice, "/alice/hello/settings/app")).text(),
    );
    expect(before).toContain("Environment");
    expect(before).toContain("never shown again");
    expect(before).toContain('type="password"');

    const set = await web(alice, "/alice/hello/settings/app/env", {
      form: { name: "API_KEY", value: secret },
    });
    expect(set.status).toBe(303);
    expect(set.headers.get("location")).toBe("/alice/hello/settings/app");
    expect(flashOf(set)).toContain("API_KEY is set");
    expect(flashOf(set)).not.toContain(secret);
    const page = await bodyOf(alice, "/alice/hello/settings/app");
    expect(page).toContain("API_KEY");
    expect(page).toContain("/alice/hello/settings/app/env/API_KEY/delete");
    expect(page).not.toContain(secret);
    expect(
      listAppEnvNames(app.db, getAppByRepo(app.db, hello.id)!.id).map(
        (v) => v.name,
      ),
    ).toEqual(["API_KEY"]);

    // A refused name says why, and changes nothing.
    const reserved = await web(alice, "/alice/hello/settings/app/env", {
      form: { name: "PORT", value: "1" },
    });
    expect(reserved.status).toBe(303);
    expect(flashOf(reserved)).toContain("PORT, HOST, PATH");
    const lower = await web(alice, "/alice/hello/settings/app/env", {
      form: { name: "not-a-name", value: "1" },
    });
    expect(flashOf(lower)).toContain("capital letters");

    // Not for a non-admin — the one 404 — and not from another origin.
    expect(
      (
        await web(bob, "/alice/hello/settings/app/env", {
          form: { name: "STOLEN", value: "x" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await web(alice, "/alice/hello/settings/app/env", {
          form: { name: "STOLEN", value: "x" },
          origin: "https://evil.example",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await web(bob, "/alice/hello/settings/app/env/API_KEY/delete", {
          form: {},
        })
      ).status,
    ).toBe(404);
    expect(
      listAppEnvNames(app.db, getAppByRepo(app.db, hello.id)!.id).map(
        (v) => v.name,
      ),
    ).toEqual(["API_KEY"]);

    const removed = await web(
      alice,
      "/alice/hello/settings/app/env/API_KEY/delete",
      { form: {} },
    );
    expect(removed.status).toBe(303);
    expect(flashOf(removed)).toContain("API_KEY is removed");
    expect(await bodyOf(alice, "/alice/hello/settings/app")).not.toContain(
      "API_KEY",
    );
    const missing = await web(
      alice,
      "/alice/hello/settings/app/env/API_KEY/delete",
      { form: {} },
    );
    expect(flashOf(missing)).toContain("No variable by that name");
  });

  test("a plain repository becomes an app from its settings, and stops being one", async () => {
    const plain = getRepo(app.db, "alice", "plain")!;
    const section = await bodyOf(alice, "/alice/plain/settings/app");
    expect(section).toContain("Run as an app");
    expect(section).toContain('value="plain"');

    // A hostname another app already answers to is refused, text kept.
    const clash = await web(alice, "/alice/plain/settings/app", {
      form: { slug: "hello", access: "private", previewData: "copy" },
    });
    expect(clash.status).toBe(422);
    expect(words(await clash.text())).toContain("already answers to that");
    expect(getAppByRepo(app.db, plain.id)).toBeUndefined();

    const enabled = await web(alice, "/alice/plain/settings/app", {
      form: { slug: "plain", access: "private", previewData: "empty" },
    });
    expect(enabled.status).toBe(303);
    expect(enabled.headers.get("location")).toBe("/alice/plain");
    expect(getAppByRepo(app.db, plain.id)?.previewData).toBe("empty");
    expect(await bodyOf(alice, "/alice/plain")).toContain(
      'href="/alice/plain/files"',
    );

    // Disabling goes through the confirm page, which words itself.
    const confirm = await bodyOf(
      alice,
      "/-/confirm?to=%2Falice%2Fplain%2Fsettings%2Fapp%2Fdisable",
    );
    expect(confirm).toContain("Stop running alice/plain as an app?");
    const disabled = await web(alice, "/alice/plain/settings/app/disable", {
      form: {},
    });
    expect(disabled.status).toBe(303);
    expect(getAppByRepo(app.db, plain.id)).toBeUndefined();
    expect((await web(alice, "/alice/plain/app")).status).toBe(404);
  });

  test("a private repository's app pages are not found to anyone who cannot read it", async () => {
    const made = await web(alice, "/new", {
      form: { owner: "alice", name: "secret", visibility: "private" },
    });
    expect(made.status).toBe(303);
    const enabled = await web(alice, "/alice/secret/settings/app", {
      form: { slug: "secret", access: "private", previewData: "copy" },
    });
    expect(enabled.status).toBe(303);
    for (const cookie of ["", bob]) {
      for (const path of [
        "/alice/secret/app",
        "/alice/secret/runs",
        "/alice/secret/app/production/open",
        "/alice/secret/settings/app",
      ]) {
        const response = await web(cookie, path);
        expect(`${path} → ${response.status}`).toBe(`${path} → 404`);
      }
    }
    expect((await web(alice, "/alice/secret/app")).status).toBe(302);
  });

  // ---- the crew ----

  test("the crew section: admin only, and an agent made on the web", async () => {
    expect((await web(bob, "/settings/crew")).status).toBe(404);
    expect(await bodyOf(bob, "/settings")).not.toContain(
      'href="/settings/crew"',
    );
    const anonymous = await web("", "/settings/crew");
    expect(anonymous.status).toBe(303);

    const page = await bodyOf(alice, "/settings/crew");
    expect(page).toContain("No agents yet");
    expect(page).toContain("No crew runner is up");
    expect(page).toContain("<h2>New agent</h2>");
    expect(await bodyOf(alice, "/settings")).toContain('href="/settings/crew"');

    const bad = await web(alice, "/settings/crew", {
      form: { username: "bot", budgetUsd: "-4", roles: "builder" },
    });
    expect(bad.status).toBe(422);
    const badPage = words(await bad.text());
    expect(badPage).toContain("A budget is a number");
    // The error sits beside its field (§5), not in an .error-note.
    expect(badPage).toMatch(
      /<div class="field" data-invalid>\s*<label for="f-budgetUsd">.*?<span class="error" id="f-budgetUsd-err">A budget is a number/,
    );
    expect(badPage).not.toContain("error-note");
    expect(getAgentByName(app.db, "bot")).toBeUndefined();

    const made = await web(alice, "/settings/crew", {
      form: {
        username: "bot",
        displayName: "Bot",
        model: "",
        brief: "Be brief.",
        budgetUsd: "2",
        roles: "builder",
      },
    });
    expect(made.status).toBe(303);
    const bot = getAgentByName(app.db, "bot")!;
    expect(bot.user.kind).toBe("agent");
    expect(bot.budgetUsd).toBe(2);
    expect(await bodyOf(alice, "/settings/crew")).toContain("Be brief.");
    expect(await bodyOf(alice, "/settings/crew")).toContain("<th>Landed</th>");
    expect(await bodyOf(alice, "/settings/crew")).toContain("<th>Per run</th>");

    const edit = await bodyOf(alice, "/settings/crew/bot");
    expect(edit).toContain('value="bot"');
    expect(edit).toContain("Retire this agent");
    const updated = await web(alice, "/settings/crew/bot", {
      form: { model: "sonnet", brief: "Be brief.", budgetUsd: "3", roles: "builder" },
    });
    expect(updated.status).toBe(303);
    expect(getAgentByName(app.db, "bot")?.model).toBe("sonnet");
    expect(getAgentByName(app.db, "bot")?.budgetUsd).toBe(3);
    // A refused edit shows the error beside its field.
    const refused = await web(alice, "/settings/crew/bot", {
      form: { model: "sonnet", brief: "Be brief.", budgetUsd: "-4", roles: "builder" },
    });
    expect(refused.status).toBe(422);
    const refusedPage = words(await refused.text());
    expect(refusedPage).toMatch(
      /<div class="field" data-invalid>\s*<label for="f-budgetUsd">.*?<span class="error" id="f-budgetUsd-err">A budget is a number/,
    );
    expect(refusedPage).not.toContain("error-note");
    expect(getAgentByName(app.db, "bot")?.budgetUsd).toBe(3);
    // A non-admin cannot touch any of it, whatever the form says.
    const forged = await web(bob, "/settings/crew/bot", {
      form: { model: "opus" },
    });
    expect(forged.status).toBe(404);
    expect(getAgentByName(app.db, "bot")?.model).toBe("sonnet");
  });

  test("a repository's crew: add, assign, refuse the ones not on it, remove", async () => {
    const before = await bodyOf(alice, "/alice/hello/settings");
    expect(before).toContain("Nobody yet");
    expect(before).toContain('<option value="bot">');
    const added = await web(alice, "/alice/hello/settings/crew", {
      form: { agent: "bot" },
    });
    expect(added.status).toBe(303);
    expect(listCrew(app.db, hello.id).map((a) => a.user.username)).toEqual([
      "bot",
    ]);
    const after = await bodyOf(alice, "/alice/hello/settings");
    expect(after).toContain('action="/alice/hello/settings/crew/bot/remove"');
    // Every agent is on the crew: nothing is left to add.
    expect(after).not.toContain("Add to crew");

    // New app now offers the agent.
    expect(await bodyOf(alice, "/apps/new")).toContain('name="agent"');

    // An issue, and the assignee control on it.
    const opened = await web(alice, "/alice/hello/issues/new", {
      form: { title: "Do a thing", body: "Please." },
    });
    expect(opened.status).toBe(303);
    const issue = getIssue(app.db, hello.id, 1)!;
    expect(issue).toBeDefined();
    const thread = await bodyOf(alice, "/alice/hello/issues/1");
    expect(thread).toContain("<h2>Assignee</h2>");
    expect(thread).toContain('action="/alice/hello/issues/1/assignee"');
    expect(thread).toContain('<option value="bot" > bot (agent)');
    expect(thread).toContain('<option value="alice"');
    // A reader sees who is on it and no form.
    expect(await bodyOf(bob, "/alice/hello/issues/1")).not.toContain(
      'action="/alice/hello/issues/1/assignee"',
    );

    const assigned = await web(alice, "/alice/hello/issues/1/assignee", {
      form: { assignee: "bot" },
    });
    expect(assigned.status).toBe(303);
    expect(flashOf(assigned)).toContain("starts working");
    expect(getIssue(app.db, hello.id, 1)?.assigneeName).toBe("bot");
    expect(await bodyOf(alice, "/alice/hello/issues/1")).toContain(
      '<option value="bot" selected',
    );

    // An agent that is not on the crew has nothing to start on.
    const idle = await createAgent(app, user("alice"), { username: "idle" });
    expect(idle.ok).toBe(true);
    const refused = await web(alice, "/alice/hello/issues/1/assignee", {
      form: { assignee: "idle" },
    });
    expect(refused.status).toBe(303);
    expect(flashOf(refused)).toContain("not on this repository");
    expect(getIssue(app.db, hello.id, 1)?.assigneeName).toBe("bot");
    // Nobody at all, and a name that is nobody.
    const nobody = await web(alice, "/alice/hello/issues/1/assignee", {
      form: { assignee: "" },
    });
    expect(nobody.status).toBe(303);
    expect(getIssue(app.db, hello.id, 1)?.assigneeName).toBeNull();
    expect(
      flashOf(
        await web(alice, "/alice/hello/issues/1/assignee", {
          form: { assignee: "ghost" },
        }),
      ),
    ).toContain("no account named ghost");
    // A reader cannot assign.
    const reader = await web(bob, "/alice/hello/issues/1/assignee", {
      form: { assignee: "alice" },
    });
    expect(reader.status).toBe(303);
    expect(flashOf(reader)).toContain("write access");
    expect(getIssue(app.db, hello.id, 1)?.assigneeName).toBeNull();

    const removed = await web(alice, "/alice/hello/settings/crew/bot/remove", {
      form: {},
    });
    expect(removed.status).toBe(303);
    expect(listCrew(app.db, hello.id)).toEqual([]);

    const retired = await web(alice, "/settings/crew/idle/delete", {
      form: {},
    });
    expect(retired.status).toBe(303);
    expect(getAgentByName(app.db, "idle")).toBeUndefined();
  });

  // ---- the pull page, and the inbox ----

  test("a pull carries the preview card, the checks line and the assignee; the dashboard's inbox lists it", async () => {
    const aliceUser = user("alice");
    const committed = await commitToBranch(app, aliceUser, hello, {
      branch: "greeting",
      base: hello.defaultBranch,
      message: "Say hello",
      files: [{ path: "GREETING.md", content: "hi\n" }],
    });
    expect(committed.ok).toBe(true);
    const opened = await openPull(app, aliceUser, hello, {
      title: "Say hello",
      baseBranch: hello.defaultBranch,
      headBranch: "greeting",
    });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const number = opened.value.number;

    // The preview is on the change; the assignee, the checks line and the
    // merge box are its Files step, one tab under it.
    const change = await bodyOf(alice, `/alice/hello/pulls/${number}`);
    expect(change).toContain("<h2>Preview</h2>");
    expect(change).toMatch(/<div\s+class="card bare[ "][^>]*>\s*<div class="card-head">\s*<svg[^]*?<h2>Preview<\/h2>/);
    const page = await bodyOf(alice, `/alice/hello/pulls/${number}/files`);
    expect(page).toContain("<h2>Assignee</h2>");
    // Checks are required: the line says so, and the box waits for them
    // unless the preview already came up green.
    expect(page).toContain('class="checks-line"');
    expect(page).toContain("a passing deploy is required");
    const check = listRuns(app.db, hello.id, {
      env: `pull-${number}`,
    }).find(
      (r) => r.commitOid === (committed.ok ? committed.value.commitOid : ""),
    );
    if (check?.state !== "ok") expect(page).toContain("Waiting on checks.");

    // On you: assigned to the viewer, the pull is a row of the home's one
    // list, under the sentence that counts it.
    const assigned = await web(alice, `/alice/hello/pulls/${number}/assignee`, {
      form: { assignee: "alice" },
    });
    expect(assigned.status).toBe(303);
    const dash = await bodyOf(alice, "/asks");
    expect(dash).toContain('<section id="needs-you"');
    expect(dash).toMatch(/<h2 id="asks-sentence">\d+ things? needs? you<\/h2>/);
    expect(dash).toContain("Say hello");
    expect(await bodyOf(bob, "/asks")).not.toContain('<section id="needs-you"');

    // Needs you: a pull the crew opened, in a repository alice can write.
    expect(addToCrew(app, aliceUser, hello, "bot").ok).toBe(true);
    const botWork = await commitToBranch(app, aliceUser, hello, {
      branch: "bot/1-do-a-thing",
      base: hello.defaultBranch,
      message: "Bot work",
      files: [{ path: "BOT.md", content: "made by bot\n" }],
    });
    expect(botWork.ok).toBe(true);
    const proposed = await openPull(app, user("bot"), hello, {
      title: "Bot did a thing",
      baseBranch: hello.defaultBranch,
      headBranch: "bot/1-do-a-thing",
    });
    expect(proposed.ok).toBe(true);
    // Whether this pull asks depends on its check, which the runtime is
    // racing to finish here: when it does, the dashboard links to /asks
    // rather than listing it (test/asks.test.ts holds that page to account).
    // Bob can read the public repo but not write it: not his inbox.
    expect(await bodyOf(bob, "/asks")).not.toContain('<section id="needs-you"');
  });

  test("the assignee select offers the people who can read the repository", async () => {
    // A public repository: any account on the forge may be put on it.
    const open = await bodyOf(alice, "/alice/hello/issues/1");
    expect(open).toContain('<option value="bob"');
    // A private one bob cannot read: he is not offered, and could not be
    // assigned if he were — the select and the action say the same thing.
    const opened = await web(alice, "/alice/secret/issues/new", {
      form: { title: "Private thing", body: "" },
    });
    expect(opened.status).toBe(303);
    const closed = await bodyOf(alice, "/alice/secret/issues/1");
    expect(closed).toContain("<h2>Assignee</h2>");
    expect(closed).toContain('<option value="alice"');
    expect(closed).not.toContain('<option value="bob"');
    const refused = await web(alice, "/alice/secret/issues/1/assignee", {
      form: { assignee: "bob" },
    });
    expect(refused.status).toBe(303);
    expect(flashOf(refused)).toContain("cannot see this repository");
  });

  // A real preview may still be deploying and stamp `serving_at` after we clear
  // it: let every run settle first, then clear the stamps.
  const noPreviewServed = async (): Promise<void> => {
    const open = () =>
      app.db.query("SELECT 1 FROM run WHERE state IN ('queued','running') LIMIT 1").get();
    for (let i = 0; i < 200 && open() !== null; i++) await Bun.sleep(25);
    if (open() !== null) throw new Error(`never came: still waiting while open() !== null`);
    app.db.query("UPDATE run SET serving_at = NULL WHERE env LIKE 'pull-%'").run();
  };

  test("the app strip says how long the first preview took, once one has served", async () => {
    await noPreviewServed();
    expect(await bodyOf(alice, "/alice/hello/files")).not.toContain("after New app");
    app.db
      .query(
        `INSERT INTO run (id, repo_id, kind, env, state, created_at, serving_at)
         VALUES ('gp-strip', ?1, 'deploy', 'pull-77', 'ok', ?2, ?2)`,
      )
      .run(hello.id, new Date(Date.now() + 60_000).toISOString());
    expect(await bodyOf(alice, "/alice/hello/files")).toMatch(/first preview [^<]* after New app/);
    app.db.query("DELETE FROM run WHERE id = 'gp-strip'").run();
  });

  test("/apps says the first preview's time beside the name, and nothing without one", async () => {
    await noPreviewServed();
    expect(await bodyOf(alice, "/apps")).not.toContain("first preview");
    app.db
      .query(
        `INSERT INTO run (id, repo_id, kind, env, state, created_at, serving_at)
         VALUES ('gp-list', ?1, 'deploy', 'pull-78', 'ok', ?2, ?2)`,
      )
      .run(hello.id, new Date(Date.now() + 60_000).toISOString());
    const listed = words(await bodyOf(alice, "/apps"));
    const secs = Math.round((Date.now() + 60_000 - Date.parse(getAppByRepo(app.db, hello.id)!.createdAt)) / 1000);
    // Created a minute before "now", give or take the seconds the test took.
    const figures = [secs - 2, secs - 1, secs, secs + 1, secs + 2].map((n) => spanWords(n * 1000));
    expect(figures.some((f) => listed.includes(`· first preview ${f}`))).toBe(true);
    expect(listed).toMatch(/class="row-meta"[^]*first preview/);
    app.db.query("DELETE FROM run WHERE id = 'gp-list'").run();
  });

  // ---- CSRF ----

  test("every new POST refuses a cross-origin submission", async () => {
    const targets = [
      "/apps/new",
      "/settings/crew",
      "/settings/crew/bot",
      "/settings/crew/bot/delete",
      "/alice/hello/settings/app",
      "/alice/hello/settings/app/disable",
      "/alice/hello/settings/crew",
      "/alice/hello/settings/crew/bot/remove",
      "/alice/hello/issues/1/assignee",
      "/alice/hello/app/production/redeploy",
      "/alice/hello/app/production/stop",
    ];
    for (const path of targets) {
      const response = await web(alice, path, {
        form: { agent: "bot", assignee: "bot", slug: "x", username: "evil" },
        origin: "https://evil.example",
      });
      expect(`${path} → ${response.status}`).toBe(`${path} → 403`);
    }
    expect(getAppByRepo(app.db, hello.id)?.slug).toBe("hello");
    expect(getAgentByName(app.db, "evil")).toBeUndefined();
    expect(getAgentByName(app.db, "bot")).toBeDefined();
  });
});
