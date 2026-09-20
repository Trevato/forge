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
import { getAppByRepo } from "../src/core/apps.ts";
import { getIssue } from "../src/core/issues.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { setLogLevel } from "../src/kernel/log.ts";

setLogLevel("error");

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
    return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
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
    alice = await signUp("alice"); // the first account: the site admin
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
    expect(created.headers.get("location")).toBe("/alice/hello/app");
    expect(flashOf(created)).toContain(
      `hello is starting at http://hello.${DOMAIN}:${servers.port}`,
    );
    hello = getRepo(app.db, "alice", "hello")!;
    expect(hello).toBeDefined();
    expect(getAppByRepo(app.db, hello.id)?.slug).toBe("hello");

    // The repo home wears the strip and the App tab.
    const home = await bodyOf(alice, "/alice/hello");
    expect(home).toContain('class="app-strip"');
    expect(home).toContain('href="/alice/hello/app/production/open"');
    expect(home).toContain('href="/alice/hello/app"');
    // A plain repository wears neither.
    const plain = await web(alice, "/new", {
      form: { owner: "alice", name: "plain", visibility: "private" },
    });
    expect(plain.status).toBe(303);
    const plainHome = await bodyOf(alice, "/alice/plain");
    expect(plainHome).not.toContain('class="app-strip"');
    expect(plainHome).not.toContain('href="/alice/plain/app"');
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
    const dash = await bodyOf(alice, "/");
    expect(dash).toContain("<h2>Apps</h2>");
    expect(dash).toContain("alice/hello");
    expect(dash).toContain('href="/alice/hello/app/production/open"');
    expect(dash).toContain('href="/apps/new"');

    const list = await bodyOf(alice, "/apps");
    expect(list).toContain("alice/hello");
    expect(list).toContain(`http://hello.${DOMAIN}:${servers.port}`);
    // Signed out, a public app is still listed; the button says sign in.
    const anonymous = await bodyOf("", "/apps");
    expect(anonymous).toContain("alice/hello");
    expect(anonymous).toContain("Sign in");
  });

  // ---- the app page and the runs ----

  test("the App page shows the environments, the runs, and the buttons a writer gets", async () => {
    const runs = await runsOf(hello);
    expect(runs.length).toBeGreaterThan(0);
    const html = await bodyOf(alice, "/alice/hello/app");
    expect(html).toContain("production");
    expect(html).toContain("Recent runs");
    expect(html).toContain("Deploy production");
    expect(html).toContain('action="/alice/hello/app/production/redeploy"');
    expect(html).toContain('href="/alice/hello/app/production/open"');
    expect(html).toContain('href="/alice/hello/settings/app"');
    // A reader sees no buttons; bob can read the public repo but not write.
    const readers = await bodyOf(bob, "/alice/hello/app");
    expect(readers).not.toContain("/redeploy");
    expect(readers).not.toContain('href="/alice/hello/settings/app"');
  });

  test("the runs list, one run's log page, and the short door to it", async () => {
    const [run] = await runsOf(hello);
    expect(run).toBeDefined();
    const list = await bodyOf(alice, "/alice/hello/runs");
    expect(list).toContain("Deploy production");
    expect(list).toContain(`href="/alice/hello/runs/${run!.id}"`);
    expect(await bodyOf(alice, "/alice/hello/runs?kind=agent")).toContain(
      "No agent runs yet",
    );

    const page = await bodyOf(alice, `/alice/hello/runs/${run!.id}`);
    expect(page).toContain("<h1>Deploy production</h1>");
    expect(page).toContain('id="run-log"');
    expect(page).toContain('id="run-state"');
    // The log is drawn line by line, each by what kind of line it is: the
    // forge's own words ("checking out …") are marked as such.
    expect(page).toContain('class="ln ln-forge"');
    expect(page).toContain('id="run-elapsed"');
    // The stream and the no-script refresh exist only while it is going.
    const fresh = listRuns(app.db, hello.id).find((r) => r.id === run!.id)!;
    const going = fresh.state === "queued" || fresh.state === "running";
    expect(page.includes("data-stream=")).toBe(going);
    expect(page.includes('http-equiv="refresh"')).toBe(going);

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
  });

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
    expect((await web(bob, "/alice/hello/settings/crew")).status).toBe(404);
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
    expect(enabled.headers.get("location")).toBe("/alice/plain/app");
    expect(getAppByRepo(app.db, plain.id)?.previewData).toBe("empty");
    expect(await bodyOf(alice, "/alice/plain")).toContain(
      'href="/alice/plain/app"',
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
    expect((await web(alice, "/alice/secret/app")).status).toBe(200);
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
    expect(page).toContain("<h3>New agent</h3>");
    expect(await bodyOf(alice, "/settings")).toContain('href="/settings/crew"');

    const bad = await web(alice, "/settings/crew", {
      form: { username: "bot", budgetUsd: "-4" },
    });
    expect(bad.status).toBe(422);
    expect(words(await bad.text())).toContain("A budget is a number");
    expect(getAgentByName(app.db, "bot")).toBeUndefined();

    const made = await web(alice, "/settings/crew", {
      form: {
        username: "bot",
        displayName: "Bot",
        model: "",
        brief: "Be brief.",
        budgetUsd: "2",
      },
    });
    expect(made.status).toBe(303);
    const bot = getAgentByName(app.db, "bot")!;
    expect(bot.user.kind).toBe("agent");
    expect(bot.budgetUsd).toBe(2);
    expect(await bodyOf(alice, "/settings/crew")).toContain("Be brief.");
    expect(await bodyOf(alice, "/settings/crew")).toContain("<th>Merged</th>");
    expect(await bodyOf(alice, "/settings/crew")).toContain("<th>Per run</th>");

    const edit = await bodyOf(alice, "/settings/crew/bot");
    expect(edit).toContain('value="bot"');
    expect(edit).toContain("Retire this agent");
    const updated = await web(alice, "/settings/crew/bot", {
      form: { model: "sonnet", brief: "Be brief.", budgetUsd: "3" },
    });
    expect(updated.status).toBe(303);
    expect(getAgentByName(app.db, "bot")?.model).toBe("sonnet");
    expect(getAgentByName(app.db, "bot")?.budgetUsd).toBe(3);
    // A non-admin cannot touch any of it, whatever the form says.
    const forged = await web(bob, "/settings/crew/bot", {
      form: { model: "opus" },
    });
    expect(forged.status).toBe(404);
    expect(getAgentByName(app.db, "bot")?.model).toBe("sonnet");
  });

  test("a repository's crew: add, assign, refuse the ones not on it, remove", async () => {
    const before = await bodyOf(alice, "/alice/hello/settings/crew");
    expect(before).toContain("No crew yet");
    expect(before).toContain('<option value="bot">');
    const added = await web(alice, "/alice/hello/settings/crew", {
      form: { agent: "bot" },
    });
    expect(added.status).toBe(303);
    expect(listCrew(app.db, hello.id).map((a) => a.user.username)).toEqual([
      "bot",
    ]);
    const after = await bodyOf(alice, "/alice/hello/settings/crew");
    expect(after).toContain('action="/alice/hello/settings/crew/bot/remove"');
    expect(after).toContain("already on this crew");

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

    const page = await bodyOf(alice, `/alice/hello/pulls/${number}`);
    expect(page).toContain("<h2>Preview</h2>");
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

    // On you: assigned to the viewer, the pull shows on the dashboard.
    const assigned = await web(alice, `/alice/hello/pulls/${number}/assignee`, {
      form: { assignee: "alice" },
    });
    expect(assigned.status).toBe(303);
    const dash = await bodyOf(alice, "/");
    expect(dash).toContain("<h2>On you</h2>");
    expect(dash).toContain("Say hello");
    expect(await bodyOf(bob, "/")).not.toContain("<h2>On you</h2>");

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
    const inbox = await bodyOf(alice, "/");
    expect(inbox).toContain("<h2>Needs you</h2>");
    expect(inbox).toContain("Bot did a thing");
    // Bob can read the public repo but not write it: not his inbox.
    expect(await bodyOf(bob, "/")).not.toContain("<h2>Needs you</h2>");
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
