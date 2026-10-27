/**
 * The cost line on /apps (#6874): today's dollars across only the apps the
 * viewer can write, how many sit paused at their ceiling, and nothing — no
 * sentence, no figure — for a guest or a reader who writes no app. Runs are
 * created now, so "today" holds without the test reading the clock itself.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import {
  commitToBranch,
  createRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { claimRun, createRun, noteRunProgress } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("the cost line on /apps", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  const cookies: Record<string, string> = {};

  const person = async (username: string, adminIfFirst = false): Promise<User> => {
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      ...(adminIfFirst ? { adminIfFirst } : {}),
    });
    if (!u.ok) throw new Error(u.error);
    promote(app.db, u.value);
    cookies[username] = (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({ username, password: "a-good-passphrase" }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
    return u.value;
  };

  /** A public app owned by `owner` (the admin makes its agent), with one crew run costing `cost` today;
   * `ceiling` turns autonomy on with that daily ceiling. */
  const appWithSpend = async (
    admin: User,
    owner: User,
    name: string,
    cost: number,
    ceiling?: number,
  ) => {
    const made = await createRepo(app, owner, {
      name,
      visibility: "public",
      description: `${name} app`,
    });
    if (!made.ok) throw new Error(String(made.error));
    const repo = made.value;
    const seeded = await commitToBranch(app, owner, repo, {
      message: "Start",
      files: [{ path: "README.md", content: `${name}\n` }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, owner, repo, { slug: name });
    if (!enabled.ok) throw new Error(String(enabled.error));
    const agent = `${name}-bot`;
    const created = await createAgent(app, admin, { username: agent });
    if (!created.ok) throw new Error(String(created.error));
    expect(addToCrew(app, owner, repo, agent).ok).toBe(true);
    if (ceiling !== undefined) {
      const on = await updateRepoSettings(app, owner, repo, {
        autonomy: "assisted",
        autonomyDirection: "",
        autonomyCeilingUsd: ceiling,
        autonomySlots: 2,
        autonomyBy: owner.id,
      });
      expect(on.ok).toBe(true);
    }
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      actorId: getUserByName(app.db, agent)!.id,
      reason: "assigned",
    });
    claimRun(app.db, run.id);
    noteRunProgress(app.db, run.id, { costUsd: cost });
  };

  const apps = (cookie?: string) =>
    fetch(`${base}/apps`, {
      headers: cookie ? { cookie: `${cookie}; forge_mode=studio` } : {},
      redirect: "manual",
    }).then((r) => r.text());

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-apps-cost-line-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const boss = await person("boss", true); // an admin writes every app: only makes agents
    const alice = await person("alice");
    const dave = await person("dave");
    await person("carol"); // writes no app
    await appWithSpend(boss, alice, "beacon", 6, 5); // paused: $6 >= $5
    await appWithSpend(boss, alice, "loom", 2); // no autonomy: never paused
    await appWithSpend(boss, dave, "other", 3.5); // alice cannot write it
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the owner reads the sum of only their own two apps and the one paused", async () => {
    const text = (await apps(cookies.alice)).replace(/\s+/g, " ");
    expect(text).toContain(
      "$8.00 spent today across 2 apps you can write · 1 paused at <a href=\"/board\">their ceiling</a>",
    );
    expect(text).not.toContain("$11.50");
  });

  test("a guest and a reader who writes no app see no cost line and no dollars", async () => {
    for (const html of [await apps(), await apps(cookies.carol)]) {
      expect(html).not.toContain("spent today");
      expect(html).not.toContain("studio-cost");
      expect(html).not.toMatch(/\$\d/);
    }
  });

  test("one app reads '1 app', and the ceiling link answers the owner 200", async () => {
    const html = (await apps(cookies.dave)).replace(/\s+/g, " ");
    expect(html).toContain("$3.50 spent today across 1 app you can write · 0 paused");
    expect(html).not.toContain("1 apps");
    const href = /<a href="([^"]+)">their ceiling<\/a>/.exec(html)?.[1];
    expect(href).toBe("/board");
    const res = await fetch(`${base}${href}`, {
      headers: { cookie: `${cookies.dave}; forge_mode=studio` },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
  });
});
