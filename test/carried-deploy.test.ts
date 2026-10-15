/**
 * A production deploy that finishes records the merged pulls it carries,
 * and says so: the run's page, the API's run, and the terminal's run list.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { newApp } from "../src/actions/apps.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { carriedBy } from "../src/core/carried.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns, type Run } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { getPull } from "../src/core/pulls.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("a production deploy carries what it records", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let repo: Repo;

  async function until<T>(read: () => T | undefined, ms = 90_000): Promise<T> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = read();
      if (value !== undefined) return value;
      await Bun.sleep(100);
    }
    throw new Error("did not happen in time");
  }
  const finished = (oid: string): Promise<Run> =>
    until(() =>
      listRuns(app.db, repo.id, { kind: "deploy", env: "production" }).find(
        (r) => r.commitOid === oid && r.state === "ok",
      ),
    );

  async function land(name: string): Promise<{ number: number; oid: string }> {
    const branch = await commitToBranch(app, alice, repo, {
      branch: `feature/${name}`,
      base: "main",
      message: name,
      files: [{ path: `${name}.md`, content: `${name}\n` }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: name,
      baseBranch: "main",
      headBranch: `feature/${name}`,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const done = await mergePull(app, alice, repo, opened.value, "squash");
    if (!done.ok) throw new Error(JSON.stringify(done.error));
    const pull = getPull(app.db, repo.id, opened.value.number)!;
    return { number: pull.number, oid: pull.mergedOid! };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-carried-deploy-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: "apps.test",
      scheme: "http" as const,
      publicPort: servers.port,
      forgeUrl: servers.url,
    });
    await runtime.start();
    const created = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    alice = created.value;
    const made = await newApp(app, alice, {
      name: "hello",
      description: "A place for notes",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value.repo;
  }, 120_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("finishing a production deploy records its merges and the API and page say so", async () => {
    const one = await land("one");
    const two = await land("two");
    const run = await finished(two.oid);
    // `done` is announced after the row is finished; the record follows it.
    await until(() => (carriedBy(app.db, run.id).length > 0 ? true : undefined));
    expect(carriedBy(app.db, run.id)).toEqual([one.number, two.number]);

    const rw = createToken(app.db, alice.id, "rw", "rw").token;
    const api = (await (
      await fetch(
        `${servers.url}/api/v1/repos/alice/hello/runs/${run.id}`,
        { headers: { authorization: `Bearer ${rw}` } },
      )
    ).json()) as { carries: number[] };
    expect(api.carries).toEqual([one.number, two.number]);

    const page = await (
      await fetch(`${servers.url}/alice/hello/runs/${run.id}`, {
        headers: { authorization: `Bearer ${rw}` },
      })
    ).text();
    expect(page).toContain('id="run-carries"');
    expect(page).toContain(`/changes/${two.number}`);
  }, 180_000);
});
