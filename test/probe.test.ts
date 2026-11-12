/**
 * Is it so: the probe knocks on a scaffolded app's doors as nobody, a user
 * and an admin, and every answer agrees with the table. Then a door is
 * broken by hand in the running app's source — a rule that lets anyone
 * delete — and the probe says exactly which cell the app disobeys. Each
 * test probes an app of its own, so neither verdict hangs on which ran first.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { AppsRuntime, appsRuntime } from "../src/apps/runtime.ts";
import { bakedFiles as scaffoldFiles } from "../src/apps/template.ts";
import { audit } from "../src/contract/audit.ts";
import { probe, type Probed } from "../src/contract/probe.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { listRuns } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("the probe asks the running app whether it obeys its table", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;

  const until = async (what: () => boolean, ms = 60_000): Promise<void> => {
    const start = Date.now();
    while (!what()) {
      if (Date.now() - start > ms) throw new Error("not in time");
      await Bun.sleep(100);
    }
  };
  /** The newest production deploy, once it has settled — and that it is ok. */
  const deployed = async (repo: Repo, after: string): Promise<string> => {
    let run: ReturnType<typeof listRuns>[number] | undefined;
    await until(() => {
      run = listRuns(app.db, repo.id, { kind: "deploy", limit: 50 }).find(
        (r) => r.env === "production" && r.createdAt > after,
      );
      return (
        run !== undefined && run.state !== "queued" && run.state !== "running"
      );
    }, 90_000);
    if (run?.state !== "ok")
      throw new Error(
        `deploy ${run?.state}: ${run?.summary} (runs: ${JSON.stringify(
          listRuns(app.db, repo.id, { kind: "deploy", limit: 10 }).map((r) => [
            r.env,
            r.state,
            r.createdAt,
            r.summary,
          ]),
        )})`,
      );
    await until(() => {
      const prod = appsRuntime(app)!
        .status(getAppByRepo(app.db, repo.id)!)
        .find((e) => e.env === "production");
      return prod?.state === "running" && prod.commitOid === run!.commitOid;
    }, 30_000);
    return run.commitOid;
  };
  const probeNow = async (repo: Repo): Promise<Probed> => {
    const record = getAppByRepo(app.db, repo.id)!;
    const fresh = getRepoById(app.db, repo.id)!;
    const audited = await audit(app.reposRoot, fresh);
    const out = await probe({
      runtime: appsRuntime(app)!,
      dataDir,
      record,
      repo: fresh,
      standing: audited.standing,
      who: { id: alice.id, name: alice.username },
    });
    if (out === undefined) throw new Error("nothing to probe");
    return out;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-probe-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const runtime = new AppsRuntime(app, {
      domain: "apps.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
    });
    await runtime.start();
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await newApp(app, alice, {
      name: "notes",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value.repo;
    await deployed(repo, "");
  }, 150_000);

  afterAll(async () => {
    await appsRuntime(app)?.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a scaffolded app obeys every cell the probe can ask", async () => {
    const out = await probeNow(repo);
    expect(out.verdict).toBe("ok");
    expect(out.said).toEqual([]);
    const asked = out.knocks.filter((k) => k.verdict !== "unprobed");
    // Every yes/no cell across five doors and three identities was asked.
    expect(asked.length).toBeGreaterThanOrEqual(10);
    expect(asked.every((k) => k.verdict === "ok")).toBe(true);
    // The own cells were not: they need a row that names the actor.
    for (const k of out.knocks.filter((k) => k.cell === "own"))
      expect(k.result.kind).toBe("unprobed");
    // The probe left nothing behind: the app has no notes.
    const record = getAppByRepo(app.db, repo.id)!;
    const port = appsRuntime(app)!.envStatus(record, "production")!.port!;
    const notes = await (
      await fetch(`http://127.0.0.1:${port}/api/notes`)
    ).json();
    expect(notes).toEqual([]);
  }, 60_000);

  test("a door that disobeys the table is named", async () => {
    // Break the app's delete door: anyone may delete now, and the table
    // still says a stranger may not. The app's own tests would catch this
    // before it ever ran — the deploy runs them first — so the change also
    // drops them, which is what a change that gets a door wrong looks like.
    const made = await newApp(app, alice, { name: "doors", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const doors = made.value.repo;
    await deployed(doors, "");
    const files = new Map(
      scaffoldFiles({ name: "doors", description: "" }).map((f) => [
        f.path,
        f.content,
      ]),
    );
    const actions = files.get("src/actions.ts") as string;
    const broken = actions.replace(
      'if (permit(who, "note", verb, row) !== "yes")',
      'if (verb !== "delete" && permit(who, "note", verb, row) !== "yes")',
    );
    expect(broken).not.toBe(actions);
    // The door asks the same table before the action does, so the rule is
    // written there too: a hand-written rule has to open both to be heard.
    const door = files.get("src/security.ts") as string;
    const opened = door.replace(
      ": !mayKnock(who, found.resource, found.verb);",
      ': found.verb !== "delete" && !mayKnock(who, found.resource, found.verb);',
    );
    expect(opened).not.toBe(door);
    const since = new Date().toISOString();
    await Bun.sleep(5);
    const wrote = await commitToBranch(app, alice, doors, {
      message: "a hand-written rule, and the tests that knew better",
      files: [
        { path: "src/actions.ts", content: broken },
        { path: "src/security.ts", content: opened },
        { path: "src/contract.test.ts", content: null },
        { path: "src/actions.test.ts", content: null },
        { path: "src/server.test.ts", content: null },
        { path: "src/audit.test.ts", content: null },
      ],
    });
    expect(wrote.ok).toBe(true);
    await deployed(doors, since);
    const out = await probeNow(doors);
    expect(out.verdict).toBe("mismatch");
    // Past the door, the stranger was told there is no such row: 404 is
    // what "admitted" looks like on an id no row has.
    expect(out.said).toEqual([
      "note.delete as anon: the table says no, the app said 404",
    ]);
    // Every other door still agrees with the table.
    expect(
      out.knocks.filter((k) => k.verdict === "mismatch").map((k) => k.verb),
    ).toEqual(["delete"]);
  }, 180_000);
});
