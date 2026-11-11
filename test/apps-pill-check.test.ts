/**
 * The forge pill names the pull's check state in plain words (#11233): from
 * the newest check of the head, escaped as a data attribute, shown for a
 * preview and never for production; the pill stays fixed and reserves no space.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import { createUser } from "../src/core/users.ts";
import { CHECK_WORDS, pillCheck } from "../src/apps/pill_check.ts";
import { toolbarJs, toolbarTag } from "../src/apps/toolbar.ts";
import { pillWhere, type AppTarget } from "../src/apps/proxy.ts";
import type { AppsRuntime } from "../src/apps/runtime.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { boot } from "./helpers/toolbar-boot.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("pillCheck", () => {
  let dataDir: string;
  let app: App;
  let repoId: string;
  let issueId: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-pill-check-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    const u = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    const made = await newApp(app, u.value, { name: "open", description: "x", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repoId = made.value.repo.id;
    const pull = createIssue(app.db, { repoId, authorId: u.value.id, title: "p", kind: "pull" });
    if (!pull.ok) throw new Error(pull.error);
    issueId = pull.value.id;
  }, 120_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const add = (id: string, oid: string, state: string) =>
    app.db.run(
      `INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state) VALUES (?1, ?2, 'check', ?3, ?4, ?5)`,
      [id, repoId, issueId, oid, state],
    );

  test("no check is said so; the newest check of this head decides", () => {
    expect(pillCheck(app.db, issueId, "aaa")).toBe("none");
    add("01a", "aaa", "failed");
    expect(pillCheck(app.db, issueId, "aaa")).toBe("failed");
    add("01b", "aaa", "running");
    expect(pillCheck(app.db, issueId, "aaa")).toBe("running");
    add("01c", "aaa", "ok");
    expect(pillCheck(app.db, issueId, "aaa")).toBe("passed");
    add("01e", "ccc", "cancelled");
    expect(pillCheck(app.db, issueId, "ccc")).toBe("cancelled");
    add("01d", "bbb", "queued");
    expect(pillCheck(app.db, issueId, "bbb")).toBe("waiting");
    expect(pillCheck(app.db, issueId, "aaa")).toBe("passed");
  });
});

describe("the pill's check line", () => {
  const drawn = (set: Record<string, string>) =>
    boot(null, 400, 800, set).texts();

  test("rides as an attribute; production's tag carries none", () => {
    expect(toolbarTag("http://f.test", { app: "a", env: "pull-3", pull: 3, check: "failed" })).toContain(
      ` data-check="failed"`,
    );
    expect(toolbarTag("http://f.test", { app: "a", env: "production" })).not.toContain("data-check");
  });

  test("the panel script draws the line for a pull, never for production or an unknown key", () => {
    const pull = { app: "notes", env: "pull-3", pull: "3" };
    expect(drawn({ ...pull, check: "failed" })).toContain(CHECK_WORDS.failed);
    expect(drawn({ ...pull, check: "cancelled" })).toContain("Checks cancelled");
    expect(drawn({ ...pull, check: "bogus" }).filter((t) => t.startsWith("Checks"))).toEqual([]);
    expect(drawn({ ...pull, check: "constructor" }).filter((t) => t.startsWith("Checks"))).toEqual([]);
    expect(drawn(pull).some((t) => /^(Checks|No checks)/.test(t))).toBe(false);
    // Production, even handed a check, names the app and says no check.
    const prod = drawn({ app: "notes", env: "production", check: "passed" });
    expect(prod).toContain("notes");
    expect(prod).toContain("Production");
    expect(prod.some((t) => /^(Checks|No checks)/.test(t))).toBe(false);
  });

  test("the bar is fixed-position and takes no room in the page", () => {
    const b = boot(null, 360, 640, { app: "notes", env: "pull-3", pull: "3", check: "passed" });
    expect(b.host.style.cssText).toContain("position:fixed");
    expect(b.host.style.cssText).not.toMatch(/margin|padding/);
    expect(toolbarJs).not.toMatch(/document\.body\.style|documentElement\.style|body\.style\.padding/);
  });
});

describe("pillWhere's check", () => {
  let dataDir: string;
  let app: App;
  let repoId: string;
  let aliceId: string;
  let target: AppTarget;
  const runtime = () => ({ app }) as unknown as AppsRuntime;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-pill-check-where-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    const a = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    aliceId = a.value.id;
    const made = await newApp(app, a.value, { name: "priv", description: "x", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    repoId = made.value.repo.id;
    target = { app: getAppByRepo(app.db, repoId)!, env: "production" } as AppTarget;
  }, 120_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const pull = (head: string, run?: string) => {
    const p = createIssue(app.db, { repoId, authorId: aliceId, title: "t", kind: "pull" });
    if (!p.ok) throw new Error(p.error);
    app.db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?1, 'main', 'topic', ?2, ?2)", [p.value.id, head || "b".repeat(40)]);
    if (head === "") app.db.run("UPDATE pull SET head_oid='' WHERE issue_id=?1", [p.value.id]);
    if (run)
      app.db.run(
        `INSERT INTO run (id, repo_id, kind, issue_id, commit_oid, state) VALUES (?1, ?2, 'check', ?3, ?4, ?5)`,
        [`r${p.value.number}`, repoId, p.value.id, head, run],
      );
    return { ...target, env: `pull-${p.value.number}` } as AppTarget;
  };

  test("a reader gets the check of the head", () => {
    const t = pull("c".repeat(40), "ok");
    expect(pillWhere(runtime(), t, { id: aliceId } as never).check).toBe("passed");
  });

  test("a head with no run says none", () => {
    const t = pull("d".repeat(40));
    expect(pillWhere(runtime(), t, { id: aliceId } as never).check).toBe("none");
  });

  test("a viewer who cannot read the pull gets no check", () => {
    const t = pull("e".repeat(40), "failed");
    const w = pillWhere(runtime(), t, undefined);
    expect(w.check).toBeUndefined();
    expect(w.title).toBeUndefined();
  });

  test("a pull with an empty head gets no check", () => {
    const t = pull("");
    const w = pillWhere(runtime(), t, { id: aliceId } as never);
    expect(w.title).toBe("t");
    expect(w.check).toBeUndefined();
  });
});
