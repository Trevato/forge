/**
 * Features in the terminal (#9544): the page's list, its switch and its
 * settings, through the same actions. A site admin finds the entry, absorbs
 * and un-absorbs, and a setting is saved or refused as on the page; anyone
 * else is not offered it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { absorbApp } from "../src/actions/features.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { clearFires, recordFire } from "../src/core/feature_fires.ts";
import { featureSettings, getAbsorbed } from "../src/core/features.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const FORGE_JSON = JSON.stringify({
  app: { run: "bun run src/server.ts" },
  feature: { name: "Radar", page: "/", settings: { runHourUtc: { type: "int", default: 13, min: 0, max: 23, label: "Hour (UTC)" }, apiToken: { type: "secret", label: "API token" } } },
});

describe("features in the terminal", () => {
  let dir: string;
  let forge: Forge;
  let ada: User;
  let eve: User;
  let appId: string;
  let repoId: string;

  function boot(user: User) {
    const terminal = headlessTerminal(120, 32);
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const key = (k: string) => app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
    const press = async (k: string) => {
      key(k);
      await settleApp(app);
      await settleApp(app);
    };
    const type = async (text: string) => {
      for (const ch of text) key(ch);
      await settleApp(app);
    };
    const palette = async (query = "Features") => {
      await settleApp(app);
      app.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
      await settleApp(app);
      await type(query);
    };
    return { text: () => app.screen.toText(), press, type, palette, stop: () => app.stop() };
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-features-tui-"));
    forge = createApp({ dataDir: dir, port: 0 });
    const make = async (username: string, adminIfFirst: boolean): Promise<User> => {
      const made = await createUser(forge.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    ada = await make("ada", true);
    eve = await make("eve", false);
    const repo = await createRepo(forge, ada, { name: "radar", owner: "ada", visibility: "public", description: "" });
    if (!repo.ok) throw new Error(JSON.stringify(repo.error));
    const done = await commitToBranch(forge, ada, repo.value, { message: "feature", files: [{ path: "forge.json", content: FORGE_JSON }] });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
    const row = insertApp(forge.db, { repoId: repo.value.id, slug: "radar", access: "public" });
    if (!row.ok) throw new Error(row.error);
    appId = row.value.id;
    repoId = repo.value.id;
  }, 60_000);
  afterAll(async () => {
    forge?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("only a site admin is offered the entry", async () => {
    const other = boot(eve);
    await other.palette();
    expect(other.text()).not.toContain("apps that declare a feature");
    other.stop();
  });

  test("an admin absorbs, saves a setting, is refused a bad one, and un-absorbs", async () => {
    const t = boot(ada);
    await t.palette();
    await t.press("enter");
    expect(t.text()).toContain("Radar");
    expect(t.text()).toContain("not absorbed");
    await t.press("a");
    expect(getAbsorbed(forge.db, appId)).toBeDefined();
    await t.press("enter");
    await t.press("enter");
    for (let i = 0; i < 4; i++) await t.press("backspace");
    await t.type("9");
    await t.press("enter");
    expect(featureSettings(forge.db, appId).get("runHourUtc")).toBe("9");
    await t.press("enter");
    for (let i = 0; i < 4; i++) await t.press("backspace");
    await t.type("99");
    await t.press("enter");
    expect(t.text()).toContain("Hour (UTC) is at most 23");
    expect(featureSettings(forge.db, appId).get("runHourUtc")).toBe("9");
    await t.press("esc");
    await t.press("a");
    expect(getAbsorbed(forge.db, appId)).toBeUndefined();
    t.stop();
  });

  test("a secret is masked, shown as kept, and a blank submit leaves it", async () => {
    const t = boot(ada);
    await t.palette();
    await t.press("enter");
    await t.press("a");
    await t.press("enter");
    expect(t.text()).toContain("not set");
    await t.press("j");
    await t.press("enter");
    await t.type("hunter2-value");
    expect(t.text()).not.toContain("hunter2-value");
    await t.press("enter");
    const kept = featureSettings(forge.db, appId).get("apiToken") ?? "";
    expect(kept).not.toBe("");
    expect(kept).not.toContain("hunter2-value");
    expect(t.text()).toContain("kept");
    await t.press("enter");
    await t.press("enter");
    expect(featureSettings(forge.db, appId).get("apiToken")).toBe(kept);
    await t.press("esc");
    await t.press("a");
    t.stop();
  });

  test("a reader opens an absorbed app's feed items from the palette", async () => {
    const absorbed = await absorbApp(forge, ada, "radar");
    if (!absorbed.ok) throw new Error(absorbed.error);
    forge.bus.append({ kind: "run.finished", repoId, actorId: ada.id, payload: { kind: "agent", state: "ok", summary: "Radar misses Tuesday", runId: "r1" } });
    const t = boot(ada);
    await t.palette("Feature feeds");
    await t.press("enter");
    expect(t.text()).toContain("Radar");
    await t.press("enter");
    expect(t.text()).toContain("Radar misses Tuesday");
    t.stop();
  });

  test("the feed screen says how the last scheduled calls went, on one line", async () => {
    recordFire(forge.db, appId, { tool: "scan", at: Date.now() - 120_000, ok: false, error: "the app answered 500", durationMs: 3 });
    const t = boot(ada);
    await t.palette("Feature feeds");
    await t.press("enter");
    await t.press("enter");
    expect(t.text()).toContain("Scheduled: scan the app answered 500");
    clearFires(forge.db, appId);
    t.stop();
  });

  test("any signed-in reader is offered it, for the apps they may read", async () => {
    const t = boot(eve);
    await t.palette("Feature feeds");
    await t.press("enter");
    expect(t.text()).toContain("Radar");
    t.stop();
  });
});
