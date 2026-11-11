/**
 * A quiet pull's preview age: `FORGE_PREVIEW_IDLE_DAYS` unset follows the
 * profit slider, read each sweep; set pins it whatever the slider says.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime, IDLE_PULL_DAYS } from "../src/apps/runtime.ts";
import { previewIdleMs } from "../src/apps/sleep_window.ts";
import { createUser, type User } from "../src/core/users.ts";
import { setEconomics } from "../src/settings/economics.ts";

const DAY = 86_400_000;

describe("FORGE_PREVIEW_IDLE_DAYS", () => {
  test("unset follows the slider; set pins the age; nonsense pins the default", () => {
    expect(previewIdleMs(undefined, IDLE_PULL_DAYS)).toBeUndefined();
    expect(previewIdleMs("2", IDLE_PULL_DAYS)).toBe(2 * DAY);
    expect(previewIdleMs("0", IDLE_PULL_DAYS)).toBe(0);
    expect(previewIdleMs("-1", IDLE_PULL_DAYS)).toBe(IDLE_PULL_DAYS * DAY);
    expect(previewIdleMs("soon", IDLE_PULL_DAYS)).toBe(IDLE_PULL_DAYS * DAY);
  });
});

describe("the runtime's idle-pull age", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  const runtime = (idlePullMs: number | undefined) =>
    new AppsRuntime(app, { domain: "apps.test", scheme: "http", forgeUrl: "http://forge.test", idlePullMs });
  const position = (n: number) => setEconomics(app.db, { position: n, marginPct: 0 }, alice.id);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-preview-idle-"));
    app = createApp({ dataDir, port: 0 });
    const made = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("unset reads the slider as it stands, with no restart", () => {
    const r = runtime(previewIdleMs(undefined, IDLE_PULL_DAYS));
    position(0);
    expect(r.idlePullAge()).toBe(DAY);
    position(50);
    expect(r.idlePullAge()).toBe(IDLE_PULL_DAYS * DAY);
    position(100);
    expect(r.idlePullAge()).toBeNull();
  });

  test("set pins it at any position, and 0 keeps every preview warm", () => {
    const pinned = runtime(previewIdleMs("2", IDLE_PULL_DAYS));
    const warm = runtime(previewIdleMs("0", IDLE_PULL_DAYS));
    for (const n of [0, 100]) {
      position(n);
      expect(pinned.idlePullAge()).toBe(2 * DAY);
      expect(warm.idlePullAge()).toBeNull();
    }
  });
});
