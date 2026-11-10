/**
 * The apps, runs and crew routes of the JSON API, driven the way an agent
 * or a script drives them: tokens with scopes, JSON in and out, the log as
 * text and as a live tail, and every floor holding.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { startCrew, type CrewHandle } from "../src/crew/dispatch.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { tokenFor } from "./helpers/tokens.ts";

/** Read from an SSE body until `predicate(buffer)` holds or we time out —
 * never to a "done" that #284's still-live stream no longer sends. */
async function readUntil(
  body: ReadableStream<Uint8Array>,
  predicate: (buf: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
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
}

describe("apps, runs and the crew over the API", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let crew: CrewHandle;
  let admin = "";
  let rw = "";

  const api = (
    path: string,
    init: RequestInit & { token?: string | null } = {},
  ) => {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && typeof init.body === "string")
      headers.set("content-type", "application/json");
    const token = init.token === undefined ? admin : init.token;
    if (token) headers.set("authorization", `Bearer ${token}`);
    return fetch(`${servers.url}${path}`, { ...init, headers });
  };
  const post = (path: string, body: unknown, token?: string | null) =>
    api(path, {
      method: "POST",
      body: JSON.stringify(body),
      ...(token === undefined ? {} : { token }),
    });

  /**
   * The first run of `alice/<repo>` that `where` picks, once it has settled.
   * Woken by the bus's `run.finished`, never by a clock: the listener is
   * on before each read, so a run that settles between the read and the
   * wait still wakes it. The deadline only bounds a run that never settles.
   */
  async function untilRun(
    repo: string,
    where: (run: Record<string, unknown>) => boolean,
  ) {
    const deadline = Date.now() + 30_000;
    for (;;) {
      let wake = () => {};
      const heard = new Promise<void>((r) => (wake = r));
      const off = app.bus.subscribe((e) => {
        if (e.kind === "run.finished") wake();
      });
      try {
        const runs = (await (
          await api(`/api/v1/repos/alice/${repo}/runs`)
        ).json()) as { items: Record<string, unknown>[] };
        const run = runs.items.find(where);
        if (run && ["ok", "failed", "cancelled"].includes(String(run.state)))
          return run;
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`run on ${repo} did not settle`);
        let bound: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          heard,
          new Promise<void>((r) => (bound = setTimeout(r, left))),
        ]);
        clearTimeout(bound);
      } finally {
        off();
      }
    }
  }

  /** Make an app of alice's over the API, as rw; `extra` adds to the body. */
  const makeApp = (name: string, extra: Record<string, unknown> = {}) =>
    post("/api/v1/apps", { name, description: "Keep notes", ...extra }, rw);

  /**
   * The apps that one case each owns and changes, keyed by name: made side
   * by side as the forge boots (`beforeAll` starts them), so their first
   * deploys overlap instead of queueing one case behind another.
   */
  const OWN_APPS: Record<string, Record<string, unknown>> = {
    opened: { visibility: "public" },
    envy: { visibility: "public" },
    hidden: { visibility: "public" },
    crewed: { visibility: "public", agent: "bot" },
    checked: {},
  };
  const owned = new Map<string, Promise<{ status: number; production: Record<string, unknown> }>>();
  const startOwn = (name: string) => {
    const made = makeApp(name, OWN_APPS[name]).then(async (res) => ({
      status: res.status,
      production: await untilRun(name, (r) => r.env === "production"),
    }));
    // Awaited by its case; a failure is that case's to report, not an
    // unhandled rejection while another case runs.
    made.catch(() => {});
    owned.set(name, made);
  };
  /** An app of its own for a case that changes it, once production serves. */
  async function servingApp(name: string) {
    const made = await owned.get(name)!;
    expect(made.status).toBe(201);
    expect(made.production.state).toBe("ok");
    return made.production;
  }

  /**
   * `hello`: the public app with `bot` on its crew, made once by whichever
   * case asks first. Cases that only read it share it; a case that changes
   * an app makes its own, so the order the cases run in does not matter.
   */
  let helloMade:
    | Promise<{ status: number; body: Record<string, unknown> }>
    | undefined;
  const hello = () =>
    (helloMade ??= makeApp("hello", { visibility: "public", agent: "bot" }).then(
      async (res) => ({
        status: res.status,
        body: (await res.json()) as Record<string, unknown>,
      }),
    ));

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-apps-api-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: "apps.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
    });
    await runtime.start();
    // A crew whose Claude Code does not exist: dispatch and the runner's
    // bookkeeping run for real, and the run fails in words, not silence.
    crew = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: join(dataDir, "no-such-claude"),
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
      // The pump on a short clock, so a queued run starts at once rather
      // than on the next of the default five-second ticks.
      tickMs: 50,
    });
    await seedAdmin(app, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
    });
    const mint = async (scope: string) =>
      (
        (await (
          await post(
            "/api/v1/tokens",
            {
              adminConfirm: true,
              username: "alice",
              password: "a-good-passphrase",
              name: scope,
              scope,
            },
            null,
          )
        ).json()) as { token: string }
      ).token;
    admin = await mint("admin");
    rw = await mint("rw");
    // The agent the cases put on crews and the plan picks.
    expect(
      (await post("/api/v1/agents", { username: "bot", budgetUsd: 1 })).status,
    ).toBe(201);
    for (const name of Object.keys(OWN_APPS)) startOwn(name);
    void hello();
  }, 30_000);

  afterAll(async () => {
    await crew.stop();
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("agents: admin creates, anyone signed in lists, rw cannot create", async () => {
    const refused = await post("/api/v1/agents", { username: "maker" }, rw);
    expect(refused.status).toBe(403);
    const made = await post("/api/v1/agents", {
      username: "maker",
      brief: "Be brief.",
      budgetUsd: 1,
    });
    expect(made.status).toBe(201);
    const agent = (await made.json()) as {
      username: string;
      budgetUsd: number;
    };
    expect(agent.username).toBe("maker");
    expect(agent.budgetUsd).toBe(1);
    const listed = (await (
      await api("/api/v1/agents", { token: rw })
    ).json()) as { items: { username: string }[] };
    expect(listed.items.map((a) => a.username)).toContain("maker");
    expect((await api("/api/v1/agents", { token: null })).status).toBe(401);
    // The agent is a user of kind agent, with no way to sign in.
    expect(getUserByName(app.db, "maker")?.kind).toBe("agent");
    const login = await post(
      "/api/v1/tokens",
      { username: "maker", password: "", name: "x", scope: "rw" },
      null,
    );
    expect(login.status).toBe(401);
  });

  test("POST /apps with pick: true says which agent the plan picked; without a plan, plan is null", async () => {
    const dir = join(dataDir, "fake-plan");
    await Bun.write(
      dir,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
printf '%s\\n' '{"is_error":false,"result":"{\\"summary\\":\\"Build it\\",\\"checklist\\":[\\"One\\"],\\"agent\\":\\"bot\\",\\"confidence\\":0.7}"}'
`,
    );
    chmodSync(dir, 0o755);
    const before = process.env["FORGE_CLAUDE"];
    try {
      process.env["FORGE_CLAUDE"] = dir;
      // The four are made side by side; the planner is on hand for each, and
      // only the one that asks for a pick with the boolean true gets one.
      const [picked, ...unpicked] = await Promise.all(
        (
          [
            ["picked", { pick: true }],
            // No pick asked, or a pick that is not the boolean true: no plan.
            ["nopick", {}],
            ["strpick", { pick: "true" }],
            ["withagent", { pick: true, agent: "bot" }],
          ] as const
        ).map(([name, extra]) => makeApp(name, extra)),
      );
      expect(picked!.status).toBe(201);
      const body = (await picked!.json()) as {
        plan: { agent: string; summary: string; confidence: number } | null;
        issue: { assigneeName: string } | null;
      };
      expect(body.plan).toEqual({ agent: "bot", summary: "Build it", confidence: 0.7 });
      expect(body.issue?.assigneeName).toBe("bot");

      for (const res of unpicked) {
        expect(res.status).toBe(201);
        expect(((await res.json()) as { plan: unknown }).plan).toBeNull();
      }

      // Planning unavailable: the app is still made, plan is null.
      process.env["FORGE_CLAUDE"] = join(dataDir, "no-such-binary");
      const bare = await post(
        "/api/v1/apps",
        { name: "unplanned", description: "Keep notes", pick: true },
        rw,
      );
      expect(bare.status).toBe(201);
      const bareBody = (await bare.json()) as { app: { slug: string }; plan: unknown };
      expect(bareBody.app.slug).toBe("unplanned");
      expect(bareBody.plan).toBeNull();
    } finally {
      if (before === undefined) delete process.env["FORGE_CLAUDE"];
      else process.env["FORGE_CLAUDE"] = before;
    }
  }, 60_000);

  test("POST /apps with a sentence and no name derives the name; a repeat gets -2; neither is 422", async () => {
    const first = await post("/api/v1/apps", { sentence: "Keep notes" }, rw);
    expect(first.status).toBe(201);
    const a = (await first.json()) as { app: { slug: string }; repo: { name: string } };
    const again = await post("/api/v1/apps", { sentence: "Keep notes" }, rw);
    expect(again.status).toBe(201);
    const b = (await again.json()) as { repo: { name: string } };
    expect(b.repo.name).toBe(`${a.repo.name}-2`);

    const both = await post("/api/v1/apps", { name: "named-wins", sentence: "Keep notes" }, rw);
    expect(((await both.json()) as { repo: { name: string } }).repo.name).toBe("named-wins");

    const neither = await post("/api/v1/apps", {}, rw);
    expect(neither.status).toBe(422);
    const nothing = await post("/api/v1/apps", { sentence: "!!!" }, rw);
    expect(nothing.status).toBe(422);
    expect(((await nothing.json()) as { error: string }).error).toBe("no_name");
  });

  test("POST /apps makes the app, puts the agent on the crew, assigns the first issue", async () => {
    const made = await hello();
    expect(made.status).toBe(201);
    const body = made.body as {
      app: { slug: string; url: string };
      issue: { number: number; assigneeName: string };
    };
    expect(body.app.slug).toBe("hello");
    expect(body.app.url).toBe(`http://hello.apps.test:${servers.port}`);
    expect(body.issue.number).toBe(1);
    expect(body.issue.assigneeName).toBe("bot");
    const crewList = (await (
      await api("/api/v1/repos/alice/hello/crew")
    ).json()) as { items: { username: string }[] };
    expect(crewList.items.map((a) => a.username)).toEqual(["bot"]);
    const apps = (await (
      await api("/api/v1/apps", { token: null })
    ).json()) as { items: { slug: string }[] };
    expect(apps.items.map((a) => a.slug)).toContain("hello");
    // The assignment dispatched an agent run. With no Claude Code to run,
    // it cloned, branched, and failed with the reason — never silently.
    expect(crew.ready).toBe(false);
    const run = await untilRun("hello", (r) => r.kind === "agent");
    expect(run.reason).toBe("assigned");
    expect(run.state).toBe("failed");
    expect(String(run.summary)).toContain("failed");
    const text = await (
      await api(`/api/v1/repos/alice/hello/runs/${run.id}/log`)
    ).text();
    expect(text).toContain("branch bot/1-build-hello from");
    // The run's credential is gone with it.
    const tokens = app.db
      .query<
        { n: number },
        [string]
      >("SELECT COUNT(*) AS n FROM token WHERE name = ?1")
      .get(`run:${run.id}`);
    expect(tokens?.n ?? 0).toBe(0);
  }, 60_000);

  test("the production run, its log as text and as a live tail that outlives the run itself (#284)", async () => {
    expect((await hello()).status).toBe(201);
    const run = await untilRun("hello", (r) => r.env === "production");
    expect(run.state).toBe("ok");
    const view = (await (
      await api("/api/v1/repos/alice/hello/app")
    ).json()) as {
      environments: { env: string; state: string; port?: number }[];
    };
    expect(view.environments[0]!.env).toBe("production");
    expect(view.environments[0]!.state).toBe("running");
    expect(view.environments[0]!.port).toBeUndefined; // never exposed as a number a client can dial past the proxy
    const text = await (
      await api(`/api/v1/repos/alice/hello/runs/${run.id}/log`)
    ).text();
    expect(text).toContain("ready:");

    // The run itself is already "ok", but its environment still points at
    // it as the one serving — its process keeps writing to this very log
    // (`apps/process.ts` pumps its stdout for the process's life), so the
    // stream must not hang up on it the moment it connects (#284).
    const controller = new AbortController();
    const tail = await api(`/api/v1/repos/alice/hello/runs/${run.id}/log?follow=1`, {
      signal: controller.signal,
    });
    expect(tail.headers.get("content-type")).toContain("text/event-stream");
    const events = await readUntil(tail.body!, (b) => b.includes("ready:"));
    expect(events).toContain("event: line");
    expect(events).not.toContain("event: done");
    // Every line is numbered, and a browser that reconnects with the last
    // number it saw hears only what followed.
    expect(events).toMatch(/id: 1\nevent: line\n/);
    const total = (events.match(/event: line\n/g) ?? []).length;
    expect(total).toBeGreaterThan(2);
    controller.abort();

    const resumeController = new AbortController();
    const resumedStream = await api(
      `/api/v1/repos/alice/hello/runs/${run.id}/log?follow=1`,
      {
        headers: { "last-event-id": String(total - 1) },
        signal: resumeController.signal,
      },
    );
    const resumed = await readUntil(
      resumedStream.body!,
      (b) => (b.match(/event: line\n/g) ?? []).length >= 1,
    );
    expect((resumed.match(/event: line\n/g) ?? []).length).toBe(1);
    expect(resumed).toContain(`id: ${total}\n`);
    expect(resumed).not.toContain("event: done");
    resumeController.abort();

    const one = (await (
      await api(`/api/v1/repos/alice/hello/runs/${run.id}`)
    ).json()) as { id: string };
    expect(one.id).toBe(String(run.id));
    // Cancelling a finished run is a conflict, not a silent no-op.
    expect(
      (await post(`/api/v1/repos/alice/hello/runs/${run.id}/cancel`, {}, rw))
        .status,
    ).toBe(409);
  });

  test("open, access, redeploy and stop", async () => {
    await servingApp("opened");
    const open = (await (
      await api("/api/v1/repos/alice/opened/app/production/open", {
        token: null,
      })
    ).json()) as { url: string };
    expect(open.url).toBe(`http://opened.apps.test:${servers.port}`);
    expect((await api("/api/v1/repos/alice/opened/app/nope/open")).status).toBe(
      422,
    );

    const patched = await api("/api/v1/repos/alice/opened/app", {
      method: "PATCH",
      body: JSON.stringify({ access: "private" }),
    });
    expect(patched.status).toBe(200);
    expect(
      (
        await api("/api/v1/repos/alice/opened/app", {
          method: "PATCH",
          body: JSON.stringify({ access: "public" }),
          token: rw,
        })
      ).status,
    ).toBe(403);
    const anon = await api("/api/v1/repos/alice/opened/app/production/open", {
      token: null,
    });
    expect(anon.status).toBe(401);
    const granted = (await (
      await api("/api/v1/repos/alice/opened/app/production/open")
    ).json()) as { url: string };
    expect(granted.url).toContain("/__forge/grant?t=");

    // The run still serving keeps a follow stream open past its own finish
    // (#284) — but only while it still serves: stopping the environment is
    // what actually retires it, and the stream must close then.
    const runs = (await (
      await api("/api/v1/repos/alice/opened/runs?env=production&limit=1")
    ).json()) as { items: { id: string }[] };
    const liveRunId = runs.items[0]!.id;
    const controller = new AbortController();
    const tail = await api(
      `/api/v1/repos/alice/opened/runs/${liveRunId}/log?follow=1`,
      { signal: controller.signal },
    );
    const reader = tail.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const readFor = async (
      predicate: (b: string) => boolean,
      timeoutMs = 3000,
    ): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
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
    };
    await readFor((b) => b.includes("event: line"));
    expect(buf).toContain("event: line");
    expect(buf).not.toContain("event: done");

    const stopped = await post(
      "/api/v1/repos/alice/opened/app/production/stop",
      {},
      rw,
    );
    expect(stopped.status).toBe(200);

    await readFor((b) => b.includes("event: done"));
    expect(buf).toContain("event: done");
    reader.cancel().catch(() => {});
    controller.abort();
    const redeployed = await post(
      "/api/v1/repos/alice/opened/app/production/redeploy",
      {},
      rw,
    );
    expect(redeployed.status).toBe(202);
    const again = await untilRun("opened", (r) => r.reason === "redeploy");
    expect(again.state).toBe("ok");
  }, 90_000);

  test("the app's environment: write-only values, handed to the process, admin only", async () => {
    // Public, so the proxy answers without a grant.
    await servingApp("envy");
    const alice = getUserByName(app.db, "alice")!;
    const repo = getRepo(app.db, "alice", "envy")!;
    // An app that prints one variable, and nothing else.
    const committed = await commitToBranch(app, alice, repo, {
      message: "Print a variable",
      files: [
        {
          path: "forge.json",
          content: JSON.stringify({ app: { run: "bun run src/server.ts" } }),
        },
        {
          path: "src/server.ts",
          content: [
            "Bun.serve({",
            '  port: Number(process.env["PORT"]),',
            '  hostname: "127.0.0.1",',
            "  fetch(request) {",
            '    return new URL(request.url).pathname === "/env"',
            '      ? new Response(process.env["GREETING"] ?? "unset")',
            '      : new Response("ok");',
            "  },",
            "});",
            "",
          ].join("\n"),
        },
      ],
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const pushed = await untilRun(
      "envy",
      (r) =>
        r.env === "production" && r.commitOid === committed.value.commitOid,
    );
    expect(pushed.state).toBe("ok");
    const viaApp = (path: string) =>
      fetch(`${servers.url}${path}`, { headers: { host: "envy.apps.test" } });
    expect(await (await viaApp("/env")).text()).toBe("unset");
    /** The newest redeploy after `after`, once it has settled. */
    const redeployAfter = (after: unknown) =>
      untilRun("envy", (r) => r.reason === "redeploy" && String(r.id) > String(after));

    const env = "/api/v1/repos/alice/envy/app/env";
    const put = (name: string, value: unknown, token?: string | null) =>
      api(`${env}/${name}`, {
        method: "PUT",
        body: JSON.stringify({ value }),
        ...(token === undefined ? {} : { token }),
      });

    // Nothing set yet, and the floors hold: admin scope, and admin over
    // the repository — a stranger with an admin token is not told the app
    // has an environment at all.
    expect(
      ((await (await api(env)).json()) as { items: unknown[] }).items,
    ).toEqual([]);
    expect((await api(env, { token: rw })).status).toBe(403);
    expect((await api(env, { token: null })).status).toBe(401);
    expect((await put("GREETING", "x", rw)).status).toBe(403);
    expect((await put("GREETING", "x", null)).status).toBe(401);
    await post(
      "/api/v1/users",
      {
        username: "mallory",
        email: "mallory@forge.local",
        password: "a-good-passphrase",
      },
      null,
    );
    const mallory = tokenFor(app, "mallory", "admin", "admin");
    expect((await api(env, { token: mallory })).status).toBe(404);
    expect((await put("GREETING", "x", mallory)).status).toBe(404);
    expect(
      (await api(`${env}/GREETING`, { method: "DELETE", token: mallory }))
        .status,
    ).toBe(404);

    // Refusals name their reason.
    for (const [name, error] of [
      ["lower", "invalid_name"],
      ["PORT", "reserved_name"],
      ["FORGE_APP_DATA", "reserved_name"],
    ] as const) {
      const refused = await put(name, "x");
      expect(refused.status).toBe(422);
      expect(((await refused.json()) as { error: string }).error).toBe(error);
    }
    expect(
      ((await (await put("GREETING", "")).json()) as { error: string }).error,
    ).toBe("invalid_value");

    // Set: the answer, the listing, the row and the event carry the name
    // and never the value.
    const secret = "hello-from-the-operator-9f1c";
    const set = await put("GREETING", secret);
    expect(set.status).toBe(200);
    const answer = await set.text();
    expect(answer).toContain('"name":"GREETING"');
    expect(answer).not.toContain(secret);
    const listed = await (await api(env)).text();
    expect(listed).toContain('"name":"GREETING"');
    expect(listed).not.toContain(secret);
    const row = app.db
      .query<{ value_enc: string }, []>("SELECT value_enc FROM app_env")
      .get();
    expect(row?.value_enc).toStartWith("v1:");
    expect(row?.value_enc).not.toContain(secret);
    const event = app.db
      .query<
        { payload: string },
        []
      >("SELECT payload FROM event WHERE kind = 'app.env_set' ORDER BY id DESC")
      .get();
    // The name and where it applies; never the value.
    expect(event?.payload).toBe('{"name":"GREETING","scope":"all"}');
    expect(answer).toContain('"scope":"all"');

    // A scope is one of three words, and a preview-only value never
    // reaches production: the process that serves keeps the one for all.
    const staging = await api(`${env}/GREETING`, {
      method: "PUT",
      body: JSON.stringify({ value: "x", scope: "staging" }),
    });
    expect(staging.status).toBe(422);
    expect(((await staging.json()) as { error: string }).error).toBe(
      "invalid_scope",
    );
    const forPreviews = await api(`${env}/GREETING`, {
      method: "PUT",
      body: JSON.stringify({ value: "only-in-previews", scope: "preview" }),
    });
    expect(forPreviews.status).toBe(200);
    expect(
      (
        (await (await api(env)).json()) as {
          items: { name: string; scope: string }[];
        }
      ).items.map((i) => `${i.name}@${i.scope}`),
    ).toEqual(["GREETING@all", "GREETING@preview"]);
    expect(
      (await api(`${env}/GREETING?scope=preview`, { method: "DELETE" })).status,
    ).toBe(200);

    // The redeploy that follows is what hands it to the app — and its log
    // does not repeat it.
    const redeployed = await redeployAfter(pushed.id);
    expect(redeployed.state).toBe("ok");
    expect(await (await viaApp("/env")).text()).toBe(secret);
    const log = await (
      await api(`/api/v1/repos/alice/envy/runs/${redeployed.id}/log`)
    ).text();
    expect(log).not.toContain(secret);

    // Remove: admin only, exact, and the next process is without it.
    expect(
      (await api(`${env}/GREETING`, { method: "DELETE", token: rw })).status,
    ).toBe(403);
    expect((await api(`${env}/GREETING`, { method: "DELETE" })).status).toBe(
      200,
    );
    const gone = await api(`${env}/GREETING`, { method: "DELETE" });
    expect(gone.status).toBe(422);
    expect(((await gone.json()) as { error: string }).error).toBe(
      "no_such_var",
    );
    expect(
      ((await (await api(env)).json()) as { items: unknown[] }).items,
    ).toEqual([]);
    const without = await redeployAfter(redeployed.id);
    expect(without.state).toBe("ok");
    expect(await (await viaApp("/env")).text()).toBe("unset");
  }, 120_000);

  test("assignee: people and crew, and the crew grant is the only way in for an agent", async () => {
    await servingApp("crewed");
    const cleared = await api("/api/v1/repos/alice/crewed/issues/1/assignee", {
      method: "PUT",
      body: JSON.stringify({ assignee: null }),
      token: rw,
    });
    expect(cleared.status).toBe(200);
    expect(
      ((await cleared.json()) as { assigneeName: string | null }).assigneeName,
    ).toBeNull();
    const nobody = await api("/api/v1/repos/alice/crewed/issues/1/assignee", {
      method: "PUT",
      body: JSON.stringify({ assignee: "ghost" }),
      token: rw,
    });
    expect(nobody.status).toBe(422);
    expect(((await nobody.json()) as { error: string }).error).toBe(
      "no_such_user",
    );
    expect(
      (
        await api("/api/v1/repos/alice/crewed/crew/bot", {
          method: "DELETE",
          token: rw,
        })
      ).status,
    ).toBe(403);
    expect(
      (await api("/api/v1/repos/alice/crewed/crew/bot", { method: "DELETE" }))
        .status,
    ).toBe(200);
    const off = await api("/api/v1/repos/alice/crewed/issues/1/assignee", {
      method: "PUT",
      body: JSON.stringify({ assignee: "bot" }),
      token: rw,
    });
    expect(off.status).toBe(422);
    expect(((await off.json()) as { error: string }).error).toBe(
      "agent_not_on_crew",
    );
    expect(
      (await api("/api/v1/repos/alice/crewed/crew/bot", { method: "PUT" }))
        .status,
    ).toBe(200);
    const on = await api("/api/v1/repos/alice/crewed/issues/1/assignee", {
      method: "PUT",
      body: JSON.stringify({ assignee: "bot" }),
      token: rw,
    });
    expect(on.status).toBe(200);
    const mine = await api("/api/v1/repos/alice/crewed/issues/1/assignee", {
      method: "PUT",
      body: JSON.stringify({ assignee: "alice" }),
      token: rw,
    });
    expect(((await mine.json()) as { assigneeName: string }).assigneeName).toBe(
      "alice",
    );
    const assigned = (await (
      await api("/api/v1/user/assigned", { token: rw })
    ).json()) as { items: { number: number; repo: { name: string } }[] };
    expect(assigned.items.map((i) => `${i.repo.name}#${i.number}`)).toEqual([
      "crewed#1",
    ]);
  });

  test("checks on a pull, and require_checks in the repo's settings", async () => {
    await servingApp("checked");
    const alice = getUserByName(app.db, "alice")!;
    const repo = getRepo(app.db, "alice", "checked")!;
    const committed = await commitToBranch(app, alice, repo, {
      branch: "change",
      base: repo.defaultBranch,
      message: "A change",
      files: [{ path: "NOTE.md", content: "note\n" }],
    });
    expect(committed.ok).toBe(true);
    const pull = await openPull(app, alice, repo, {
      title: "A change",
      baseBranch: repo.defaultBranch,
      headBranch: "change",
    });
    expect(pull.ok).toBe(true);
    if (!pull.ok || !committed.ok) return;
    const run = await untilRun("checked", (r) => r.env === `pull-${pull.value.number}`);
    expect(run.state).toBe("ok");
    const checks = (await (
      await api(`/api/v1/repos/alice/checked/pulls/${pull.value.number}/checks`)
    ).json()) as {
      head: string;
      state: string;
      required: boolean;
      runs: unknown[];
    };
    expect(checks.head).toBe(committed.value.commitOid);
    expect(checks.state).toBe("ok");
    expect(checks.required).toBe(false);
    const settings = await api("/api/v1/repos/alice/checked", {
      method: "PATCH",
      body: JSON.stringify({ requireChecks: true }),
    });
    expect(
      ((await settings.json()) as { requireChecks: boolean }).requireChecks,
    ).toBe(true);
    expect(
      (
        (await (
          await api(
            `/api/v1/repos/alice/checked/pulls/${pull.value.number}/checks`,
          )
        ).json()) as { required: boolean }
      ).required,
    ).toBe(true);
  }, 90_000);

  test("the app carries firstPreviewMs once a preview has served, and not before", async () => {
    expect((await hello()).status).toBe(201);
    const read = async () =>
      (await (await api("/api/v1/repos/alice/hello/app")).json()) as { firstPreviewMs?: number };
    const repoId = app.db.query<{ id: string }, []>("SELECT id FROM repo WHERE name = 'hello'").get()!.id;
    app.db.query("UPDATE run SET serving_at = NULL WHERE env LIKE 'pull-%' AND repo_id = ?1").run(repoId);
    expect((await read()).firstPreviewMs).toBeUndefined();
    app.db
      .query(
        `INSERT INTO run (id, repo_id, kind, env, state, created_at, serving_at)
         VALUES ('gp-pace', ?1, 'deploy', 'pull-77', 'ok', ?2, ?2)`,
      )
      .run(repoId, new Date(Date.now() + 60_000).toISOString());
    expect(typeof (await read()).firstPreviewMs).toBe("number");
    app.db.query("DELETE FROM run WHERE id = 'gp-pace'").run();
  });

  test("a private repo's app is not_found to strangers; disabling removes it", async () => {
    await servingApp("hidden");
    expect(
      (await fetch(`${servers.url}/`, { headers: { host: "hidden.apps.test" } }))
        .status,
    ).toBe(200);
    await api("/api/v1/repos/alice/hidden", {
      method: "PATCH",
      body: JSON.stringify({ visibility: "private" }),
    });
    expect(
      (await api("/api/v1/repos/alice/hidden/app", { token: null })).status,
    ).toBe(404);
    expect((await api("/api/v1/apps", { token: null })).ok).toBe(true);
    expect(
      (
        (await (await api("/api/v1/apps", { token: null })).json()) as {
          items: { slug: string }[];
        }
      ).items.map((a) => a.slug),
    ).not.toContain("hidden");
    expect(
      (
        await api("/api/v1/repos/alice/hidden/app", {
          method: "DELETE",
          token: rw,
        })
      ).status,
    ).toBe(403);
    expect(
      (await api("/api/v1/repos/alice/hidden/app", { method: "DELETE" })).status,
    ).toBe(200);
    expect((await api("/api/v1/repos/alice/hidden/app")).status).toBe(404);
    // The proxy reads the app's row on every request, and the DELETE took
    // it before answering: the host is gone at once, no waiting.
    expect(
      (await fetch(`${servers.url}/`, { headers: { host: "hidden.apps.test" } }))
        .status,
    ).toBe(404);
  });

  test("agents: update and retire", async () => {
    expect(
      (await post("/api/v1/agents", { username: "retiree", budgetUsd: 1 })).status,
    ).toBe(201);
    const patched = await api("/api/v1/agents/retiree", {
      method: "PATCH",
      body: JSON.stringify({ budgetUsd: 2, model: "sonnet" }),
    });
    expect(
      ((await patched.json()) as { budgetUsd: number; model: string }).model,
    ).toBe("sonnet");
    expect(
      (await api("/api/v1/agents/retiree", { method: "DELETE", token: rw })).status,
    ).toBe(403);
    expect((await api("/api/v1/agents/retiree", { method: "DELETE" })).status).toBe(
      200,
    );
    expect((await api("/api/v1/agents/retiree")).status).toBe(404);
  });
});
