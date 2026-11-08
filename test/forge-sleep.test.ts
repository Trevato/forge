/**
 * A hosted forge scales to zero: it sleeps after a quiet period, wakes on a
 * page load and on a `git push` with its data kept, a sleeping forge is woken
 * only within the host's limits (awake ceiling, wakes an hour, an address's
 * rate), a stranger cannot hold one awake, a person owns only so many, and
 * the owner stops and removes one (admin only, same-origin, confirmed).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnForge } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { awakeCount, childAwake, holdChild, resolveHostedChild, sleepIdleChildren, wakeGate } from "../src/spawn/host.ts";
import { removeForge, stopForge } from "../src/spawn/manage.ts";
import { setLimit } from "../src/settings/limits.ts";
import { awakeRefusal, personRefusal, WakeRate } from "../src/spawn/sleep.ts";
import { wakingResponse } from "../src/web/pages/waking.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";

quietLogs();

const CHILD_HOST = "homie--forge.test";

async function git(args: string[], cwd: string): Promise<{ code: number; err: string }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: gitClientEnv(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, err: err.trim() };
}


const later = () => Date.now() + 3_600_000;

describe("a hosted forge scales to zero", () => {
  let dir = "";
  let work = "";
  let parent: App;
  let servers: Servers;
  let token = "";
  const remote = () => `${servers.url.replace("http://", `http://bob:${token}@`)}/bob/app.git`;
  const asChild = (path: string) =>
    fetch(`${servers.url}${path}`, { headers: { host: CHILD_HOST, authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-sleep-"));
    work = await mkdtemp(join(tmpdir(), "forge-sleep-work-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const made = await createUser(parent.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.invalid", isAdmin: true });
    if (!made.ok) throw new Error("user");
    const spawned = await spawnForge(
      parent,
      made.value,
      { name: "homie", org: "homie", apps: [], carryBriefs: false, carrySubscriptions: false },
      { catalog: [], briefs: [], subscriptions: [] },
      {
        placement: hostedPlacement({ host: "forge.test" }),
        request: new Request("https://forge.test/spawn", { method: "POST", headers: { origin: "https://forge.test" } }),
        url: new URL("https://forge.test/spawn"),
      },
    );
    if (!spawned.ok) throw new Error(JSON.stringify(spawned.error));
    servers = await serve(parent);
    const opened = await resolveHostedChild(parent, new Request("https://forge.test/healthz", { headers: { host: CHILD_HOST } }));
    if (opened === undefined || opened === "unknown" || opened === "cell") throw new Error("child not hosted");
    const bob = await createUser(opened.db, { origin: "seed", trusted: true, username: "bob", email: "b@x.invalid" });
    if (!bob.ok) throw new Error("child user");
    promote(opened.db, bob.value);
    token = tokenFor(opened, "bob", "rw");
    const created = await fetch(`${servers.url}/api/v1/repos`, {
      method: "POST",
      headers: { host: CHILD_HOST, authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "app" }),
    });
    if (created.status !== 201) throw new Error(`repo: ${created.status}`);
  });

  afterAll(async () => {
    servers?.stop();
    parent?.close();
    await rm(work, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });

  test("sleeps after a quiet period, wakes on a page load, and keeps its data", async () => {
    expect(childAwake(parent, "homie")).toBe(true);
    // Not quiet long enough: nothing sleeps.
    expect(await sleepIdleChildren(parent, 600_000, Date.now())).toEqual([]);
    expect(await sleepIdleChildren(parent, 600_000, later())).toEqual(["homie"]);
    expect(childAwake(parent, "homie")).toBe(false);
    expect(awakeCount(parent)).toBe(0);

    const page = await fetch(`${servers.url}/healthz`, { headers: { host: CHILD_HOST } });
    expect(page.status).toBe(200);
    expect(childAwake(parent, "homie")).toBe(true);
    const repo = await asChild("/api/v1/repos/bob/app");
    expect(repo.status).toBe(200);
  });

  test("wakes on a git push, and the data from before the sleep is still there", async () => {
    const repo = join(work, "app");
    expect((await git(["init", "-q", "-b", "main", repo], work)).code).toBe(0);
    await Bun.write(join(repo, "README.md"), "# app\n");
    expect((await git(["add", "."], repo)).code).toBe(0);
    expect((await git(["commit", "-qm", "genesis"], repo)).code).toBe(0);
    const first = await git(["-c", `http.extraHeader=Host: ${CHILD_HOST}`, "push", remote(), "main"], repo);
    expect(first.code).toBe(0);

    expect(await sleepIdleChildren(parent, 600_000, later())).toEqual(["homie"]);
    expect(childAwake(parent, "homie")).toBe(false);

    await Bun.write(join(repo, "NEXT.md"), "next\n");
    expect((await git(["add", "."], repo)).code).toBe(0);
    expect((await git(["commit", "-qm", "after sleep"], repo)).code).toBe(0);
    const second = await git(["-c", `http.extraHeader=Host: ${CHILD_HOST}`, "push", remote(), "main"], repo);
    expect(second.err).not.toContain("hook relay failed");
    expect(second.code).toBe(0);
    expect(childAwake(parent, "homie")).toBe(true);

    const events = (await (await asChild("/api/v1/repos/bob/app/events")).json()) as { items: { kind: string }[] };
    expect(events.items.filter((e) => e.kind === "push").length).toBe(2);
  });

  test("a wake that would pass a limit is refused in plain words, and a sleeping forge is not counted", async () => {
    expect(awakeRefusal(1, { FORGE_CHILD_AWAKE_MAX: "2" })).toBeUndefined();
    expect(awakeRefusal(2, { FORGE_CHILD_AWAKE_MAX: "2" })).toContain("try again in a minute");
    const rates = new WakeRate();
    const env = { FORGE_CHILD_WAKES_PER_HOUR: "2" };
    rates.note("b", 1000);
    rates.note("b", 2000);
    expect(rates.refusal("b", 3000, env)).toContain("woken 2 times");
    expect(rates.refusal("b", 3000 + 3_600_000, env)).toBeUndefined();
    const refused = wakingResponse(parent, new Request("https://x"), "homie", "too many");
    expect(refused.status).toBe(429);
    expect(await refused.text()).toBe("too many");
  });

  test("a person owns at most so many forges; a site admin is not limited", () => {
    // Alice made homie: with a ceiling of 1 she (an admin) is still free, a person is not.
    expect(setLimit(parent.db, "forges.per_person", 1, "seed").ok).toBe(true);
    try {
      const owner = parent.db.query("SELECT id FROM user WHERE username = 'alice'").get() as { id: string };
      expect(personRefusal(parent.db, dir, { id: owner.id, isAdmin: true })).toBeUndefined();
      expect(personRefusal(parent.db, dir, { id: owner.id, isAdmin: false })).toContain("1 forge, the most");
      expect(personRefusal(parent.db, dir, { id: "someone-else", isAdmin: false })).toBeUndefined();
    } finally {
      setLimit(parent.db, "forges.per_person", null, "seed");
    }
  });

  test("a waking page is plain for a browser, and the gate lets an awake forge through", async () => {
    const page = wakingResponse(parent, new Request("https://forge.test/", { headers: { accept: "text/html" } }), "homie");
    expect(page.status).toBe(503);
    expect(page.headers.get("refresh")).toBe("3");
    const text = await page.text();
    expect(text).toContain("Waking up");
    expect(text).not.toContain("style=");
    expect(wakeGate(parent, new Request("https://forge.test/", { headers: { host: CHILD_HOST } }))).toBeUndefined();
  });

  const asleepAgain = async () => {
    await sleepIdleChildren(parent, 600_000, later());
    expect(childAwake(parent, "homie")).toBe(false);
  };
  const gate = (headers: Record<string, string> = {}) =>
    wakeGate(parent, new Request("https://forge.test/", { headers: { host: CHILD_HOST, ...headers } }));

  test("the gate refuses a wake at the awake ceiling, and the slot is held so two wakes cannot both pass", async () => {
    await asleepAgain();
    const was = process.env["FORGE_CHILD_AWAKE_MAX"];
    process.env["FORGE_CHILD_AWAKE_MAX"] = "1";
    try {
      expect(gate()).toBeUndefined(); // the first wake is granted and holds the one slot
      expect(awakeCount(parent)).toBe(1);
      // Another forge's wake now would pass the ceiling: the slot is reserved though nothing is open yet.
      expect(awakeRefusal(awakeCount(parent))).toContain("try again in a minute");
    } finally {
      if (was === undefined) delete process.env["FORGE_CHILD_AWAKE_MAX"];
      else process.env["FORGE_CHILD_AWAKE_MAX"] = was;
    }
  });

  test("a stranger's wakes are counted against the forge's hour, a request with a session is not", async () => {
    await asleepAgain();
    await sleepIdleChildren(parent, 0, later()); // clears any reservation by the passage of the wake
    const was = process.env["FORGE_CHILD_WAKES_PER_HOUR"];
    process.env["FORGE_CHILD_WAKES_PER_HOUR"] = "1";
    try {
      // Reservations from the earlier test are cleared by opening and sleeping the forge.
      await fetch(`${servers.url}/healthz`, { headers: { host: CHILD_HOST } });
      await asleepAgain();
      const strangers = [gate(), gate()];
      expect(strangers.some((r) => r?.status === 429)).toBe(true);
      const known = gate({ authorization: `Bearer ${token}` });
      expect(known?.status ?? 0).not.toBe(429);
    } finally {
      if (was === undefined) delete process.env["FORGE_CHILD_WAKES_PER_HOUR"];
      else process.env["FORGE_CHILD_WAKES_PER_HOUR"] = was;
    }
  });

  test("a stranger's visit does not keep an awake forge awake; a signed-in one does", async () => {
    await fetch(`${servers.url}/healthz`, { headers: { host: CHILD_HOST } });
    expect(childAwake(parent, "homie")).toBe(true);
    // Idle by the clock an hour from now: a stranger's request in between changes nothing.
    expect(gate()).toBeUndefined();
    expect(await sleepIdleChildren(parent, 600_000, later())).toEqual(["homie"]);
    await fetch(`${servers.url}/healthz`, { headers: { host: CHILD_HOST } });
    expect(gate({ authorization: `Bearer ${token}` })).toBeUndefined();
    expect(await sleepIdleChildren(parent, 600_000, Date.now() + 1000)).toEqual([]);
  });

  test("a bogus Authorization header or session cookie is a stranger's: limited, and it keeps nothing awake", async () => {
    const bogus = [{ authorization: "x" }, { authorization: "Bearer forge_not-a-real-token" }, { cookie: "forge_session=made-up" }];
    const was = process.env["FORGE_CHILD_WAKES_PER_HOUR"];
    process.env["FORGE_CHILD_WAKES_PER_HOUR"] = "1";
    try {
      await fetch(`${servers.url}/healthz`, { headers: { host: CHILD_HOST } });
      await asleepAgain();
      const answers = bogus.map((h) => gate(h));
      expect(answers.some((r) => r?.status === 429)).toBe(true);
    } finally {
      if (was === undefined) delete process.env["FORGE_CHILD_WAKES_PER_HOUR"];
      else process.env["FORGE_CHILD_WAKES_PER_HOUR"] = was;
    }
    await fetch(`${servers.url}/healthz`, { headers: { host: CHILD_HOST } });
    expect(childAwake(parent, "homie")).toBe(true);
    for (const h of bogus) expect(gate(h)).toBeUndefined();
    expect(await sleepIdleChildren(parent, 600_000, later())).toEqual(["homie"]);
  });

  test("a real session cookie of the child's keeps it awake; a made-up one does not", async () => {
    const child = (await resolveHostedChild(parent, new Request("https://forge.test/healthz", { headers: { host: CHILD_HOST } }))) as App;
    const bob = child.db.query("SELECT id FROM user WHERE username = 'bob'").get() as { id: string };
    const { token: session } = createSession(child.db, bob.id);
    // Each round: the last touch is at least 30 ms old, one request, then a sweep that sleeps what is 20 ms idle.
    const round = async (cookie: string) => {
      await fetch(`${servers.url}/healthz`, { headers: { host: CHILD_HOST, authorization: `Bearer ${token}` } });
      await Bun.sleep(30);
      const t = Date.now();
      expect(gate({ cookie })).toBeUndefined();
      return sleepIdleChildren(parent, 20, t + 10);
    };
    expect(await round("forge_session=made-up")).toEqual(["homie"]);
    expect(await round(`theme=dark; forge_session=${session}`)).toEqual([]);
  });

  test("a forge answering a request is not put to sleep under it", async () => {
    const child = (await resolveHostedChild(parent, new Request("https://forge.test/healthz", { headers: { host: CHILD_HOST } }))) as App;
    const release = holdChild(parent, child);
    expect(await sleepIdleChildren(parent, 0, later())).toEqual([]);
    release();
    expect(await sleepIdleChildren(parent, 0, later())).toEqual(["homie"]);
  });

  test("a person's forge limit holds through spawnForge", async () => {
    expect(setLimit(parent.db, "forges.per_person", 1, "seed").ok).toBe(true);
    try {
      const carol = await createUser(parent.db, { origin: "seed", trusted: true, username: "carol", email: "c@x.invalid" });
      if (!carol.ok) throw new Error("carol");
      const make = (name: string) =>
        spawnForge(
          parent,
          carol.value,
          { name, org: name, apps: [], carryBriefs: false, carrySubscriptions: false },
          { catalog: [], briefs: [], subscriptions: [] },
          {
            placement: hostedPlacement({ host: "forge.test" }),
            request: new Request("https://forge.test/spawn", { method: "POST", headers: { origin: "https://forge.test" } }),
            url: new URL("https://forge.test/spawn"),
          },
        );
      expect((await make("carols-first")).ok).toBe(true);
      const second = await make("carols-second");
      expect(second.ok).toBe(false);
      if (!second.ok) expect(JSON.stringify(second.error)).toContain("remove one first");
    } finally {
      setLimit(parent.db, "forges.per_person", null, "seed");
    }
  });

  test("stop and remove are an admin's, same-origin, and removal asks first", async () => {
    const aliceToken = tokenFor(parent, "alice", "admin");
    const carolToken = tokenFor(parent, "carol", "rw");
    const post = (path: string, bearer: string, origin: string | undefined) =>
      fetch(`${servers.url}${path}`, {
        method: "POST",
        redirect: "manual",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/x-www-form-urlencoded", ...(origin === undefined ? {} : { origin }) },
        body: "",
      });
    expect((await post("/forges/homie/stop", carolToken, "https://forge.test")).status).toBe(404);
    expect((await post("/forges/homie/remove", carolToken, "https://forge.test")).status).toBe(404);
    expect(existsSync(join(dir, "spawn", "homie.json"))).toBe(true);
    const cross = await post("/forges/homie/remove", aliceToken, "https://evil.example");
    expect(cross.status).toBe(403);
    expect(existsSync(join(dir, "spawn", "homie.json"))).toBe(true);
    const confirm = await fetch(`${servers.url}/forges/homie/remove`, { headers: { authorization: `Bearer ${aliceToken}` } });
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain("cannot be undone");
    const asCarol = await fetch(`${servers.url}/forges/homie/remove`, { headers: { authorization: `Bearer ${carolToken}` } });
    expect(asCarol.status).toBe(404);
    const stopped = await post("/forges/homie/stop", aliceToken, "https://forge.test");
    expect(stopped.status).toBe(200);
  });

  test("/agents makes a forge in one step: its form posts the name straight to the spawn", async () => {
    const aliceToken = tokenFor(parent, "alice", "admin");
    const agents = await (await fetch(`${servers.url}/agents`)).text();
    expect(agents).toContain('<form method="post" action="/forges/new" class="stack" id="agent-forge">');
    // What that form sends, and nothing else: the forge is made, its claim link in the answer.
    const made = await fetch(`${servers.url}/forges/new`, {
      method: "POST",
      headers: { authorization: `Bearer ${aliceToken}`, origin: "https://forge.test", "content-type": "application/x-www-form-urlencoded" },
      body: "name=from-agents",
    });
    expect(made.status).toBeLessThan(300);
    expect(await made.text()).toContain("claim");
    expect(existsSync(join(dir, "spawn", "from-agents.json"))).toBe(true);
  });

  test("the owner stops a forge, then removes it with its data", async () => {
    expect((await stopForge(parent, "homie")).says).toContain("asleep");
    expect(childAwake(parent, "homie")).toBe(false);
    expect((await stopForge(parent, "Not A Name")).ok).toBe(false);
    const removed = await removeForge(parent, "homie");
    expect(removed.ok).toBe(true);
    expect(existsSync(join(dir, "spawn", "homie.json"))).toBe(false);
    const gone = await fetch(`${servers.url}/healthz`, { headers: { host: CHILD_HOST } });
    expect(gone.status).toBe(404);
  });
});
