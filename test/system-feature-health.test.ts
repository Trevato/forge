/**
 * An absorbed app's health on /system and in the `system` MCP answer (#9887):
 * the row says what production's environment says; an app the runtime does
 * not hold is "none", not healthy; a failed newer deploy shows although an
 * older one serves; unhealthy rows come first; an agent sees public apps only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { absorb } from "../src/core/features.ts";
import { createUser, type User } from "../src/core/users.ts";
import { systemWithReaders } from "../src/system/telemetry.ts";
import { featureHealth, healthOf } from "../src/system/feature_health.ts";
import { featuresSection } from "../src/web/pages/system.ts";
import { Session } from "../src/tui/session.ts";
import { featuresLines } from "../src/tui/screens/system.ts";
import { getUserByName } from "../src/core/users.ts";
import type { EnvStatus } from "../src/apps/runtime.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const env = (over: Partial<EnvStatus>): EnvStatus => ({ env: "production", state: "running", commitOid: "abcdef0123456789", url: "http://x", ...over });
const base = { slug: "radar", name: "Radar", repo: "cy/radar" };

describe("healthOf", () => {
  test("running with nothing failed is healthy, with a short commit", () => {
    const h = healthOf(base, env({ servingAt: "2026-11-08T10:00:00Z" }));
    expect(h).toMatchObject({ state: "running", healthy: true, commit: "abcdef0", since: "2026-11-08T10:00:00Z", problem: null });
  });
  test("a failed environment is down and says why", () => {
    const h = healthOf(base, env({ state: "failed", error: "port never answered" }));
    expect(h).toMatchObject({ healthy: false, state: "failed", problem: "port never answered" });
  });
  test("a newer deploy that failed makes it unhealthy although the old one serves", () => {
    const h = healthOf(base, env({ failedDeploy: { commitOid: "1234567890", runId: "r", error: "tests red" } }));
    expect(h.state).toBe("running");
    expect(h.healthy).toBe(false);
    expect(h.problem).toBe("a newer deploy failed: tests red");
  });
  test("an app the runtime holds nothing for is none, not healthy", () => {
    expect(healthOf(base, undefined)).toMatchObject({ state: "none", healthy: false, commit: null });
  });
});

describe("the rows and where they show", () => {
  let dataDir: string;
  let app: App;
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-fh-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "ada", email: "ada@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!made.ok) throw new Error(made.error);
    const ada: User = made.value;
    for (const [name, visibility] of [["pubapp", "public"], ["privapp", "private"]] as const) {
      const repo = await createRepo(app, ada, { name, visibility, description: "" });
      if (!repo.ok) throw new Error(String(repo.error));
      const row = insertApp(app.db, { repoId: repo.value.id, slug: name, access: visibility });
      if (!row.ok) throw new Error(row.error);
      absorb(app.db, row.value.id, ada.id, name === "pubapp" ? "Public" : "Private", "/");
    }
  });
  afterAll(async () => {
    app.db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the owner sees every absorbed app; with no runtime each is none", () => {
    const rows = featureHealth(app, { kind: "owner" });
    expect(rows.map((r) => r.name)).toEqual(["Private", "Public"]);
    expect(rows.every((r) => r.state === "none" && !r.healthy)).toBe(true);
  });
  test("an agent sees public apps only", () => {
    expect(featureHealth(app, { kind: "agent" }).map((r) => r.name)).toEqual(["Public"]);
  });
  test("the system answer carries them", () => {
    expect(systemWithReaders(app, { kind: "owner" }).features).toHaveLength(2);
  });
  test("the section names each feature, escaped, and is empty with none", () => {
    const text = featuresSection([healthOf({ slug: "x", name: "<b>Radar</b>", repo: "cy/radar" }, env({}))]).text;
    expect(text).toContain("&lt;b&gt;Radar");
    expect(text).not.toContain("<b>Radar");
    expect(featuresSection([]).text).toBe("");
  });
  test("a healthy feature is a line, not a table row; an unhealthy one carries its problem", () => {
    const text = featuresSection([healthOf(base, env({})), healthOf({ ...base, slug: "b", name: "Bad" }, env({ state: "failed", error: "boom" }))]).text;
    expect(text).not.toContain("<table");
    expect(text).toContain("boom");
  });
  test("the terminal draws them for the owner only", () => {
    const id = (user?: User) => ({ sshUsername: user?.username ?? "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user });
    const lines = featuresLines(new Session(app, id(getUserByName(app.db, "ada"))));
    expect(lines[0]).toBe("Features from apps");
    expect(lines.join("\n")).toContain("Private");
    expect(featuresLines(new Session(app, id(undefined)))).toEqual([]);
  });
});
