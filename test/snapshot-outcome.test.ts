/**
 * A failed snapshot is seen the same morning (#2536): it is kept under the
 * data directory, vitals carries it as a card and Backups as a red line,
 * both pointing at the reason, and the forge tries again within the hour
 * rather than the next night. A snapshot that lands clears it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forgeNeeds, forgeVitals } from "../src/actions/health.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { lastSnapshotOutcome, recordSnapshotOutcome, snapshotNeed } from "../src/snapshot/outcome.ts";
import { startSnapshots } from "../src/snapshot/service.ts";
import { dirStore, type Store } from "../src/snapshot/store.ts";

const failed = (app: App) => forgeVitals(app).degraded.find((d) => d.cause === "snapshot-failed");

describe("the outcome kept", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "forge-outcome-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("none kept is no card; a failure is one from its first morning; one that lands clears it", () => {
    expect(snapshotNeed(lastSnapshotOutcome(dir))).toBeUndefined();
    recordSnapshotOutcome(dir, { landed: "2026-10-16T08-00-00Z" }, "2026-10-16T08:40:00.000Z");
    expect(snapshotNeed(lastSnapshotOutcome(dir))).toBeUndefined();
    recordSnapshotOutcome(dir, { error: "could not put forge.db: no answer in 180 s." }, "2026-10-17T08:45:00.000Z");
    recordSnapshotOutcome(dir, { error: "could not put forge.db: no answer in 180 s." }, "2026-10-18T08:00:00.000Z");
    const need = snapshotNeed(lastSnapshotOutcome(dir));
    expect(need?.since).toBe("2026-10-17T08:45:00.000Z");
    expect(need?.sentence).toBe(
      "The last snapshot failed: could not put forge.db: no answer in 180 s. The newest that landed is from 2026-10-16. The forge tries again within the hour.",
    );
    recordSnapshotOutcome(dir, { landed: "2026-10-18T09-00-00Z" }, "2026-10-18T09:20:00.000Z");
    expect(snapshotNeed(lastSnapshotOutcome(dir))).toBeUndefined();
    expect(lastSnapshotOutcome(dir)?.landed).toBe("2026-10-18T09-00-00Z");
  });
});

describe("a nightly that fails", () => {
  let root: string;
  let app: App;
  let servers: Servers;
  let cookie: string;
  let admin: User;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-outcome-svc-"));
    app = createApp({ dataDir: join(root, "data"), port: 0 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    admin = a.value;
    servers = await serve(app);
    const signedIn = await fetch(`${servers.url}/signin`, {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0]!;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(root, { recursive: true, force: true });
  });

  test("is a card on vitals and a red line on Backups at once, and the next try lands and clears both", async () => {
    const inner = dirStore(join(root, "store"));
    let broken = true;
    const store: Store = {
      ...inner,
      put: async (key, body) => {
        if (broken && key.includes("forge.db")) throw new Error("no answer in 180 s");
        return inner.put(key, body);
      },
    };
    const svc = startSnapshots(app, store, { version: "t", retryMs: 300 });
    try {
      await expect(svc.now()).rejects.toThrow(/no answer in 180 s/);
      const card = failed(app);
      expect(card?.sentence).toContain("The last snapshot failed");
      expect(card?.sentence).toContain("no answer in 180 s");
      expect(card?.href).toBe("/settings/backups");
      // The terminal's dashboard prints the forge's needs: the card is there too.
      expect(forgeNeeds(app, admin)?.some((l) => l.includes("The last snapshot failed"))).toBe(true);
      const page = await (await fetch(`${servers.url}/settings/backups`, { headers: { cookie } })).text();
      expect(page).not.toContain("backups-error");
      expect(page.replace(/\s+/g, " ")).toContain("The last snapshot failed");
      expect(page).toContain("no answer in 180 s");

      // Nobody asks again: the forge does, within the retry, not the next night.
      broken = false;
      const until = Date.now() + 10_000;
      while (lastSnapshotOutcome(app.config.dataDir)?.failingSince !== undefined && Date.now() < until)
        await Bun.sleep(50);
      expect(lastSnapshotOutcome(app.config.dataDir)?.landed).toBeDefined();
      expect(failed(app)).toBeUndefined();
      const after = await (await fetch(`${servers.url}/settings/backups`, { headers: { cookie } })).text();
      expect(after.replace(/\s+/g, " ")).not.toContain("The last snapshot failed");
    } finally {
      await svc.stop();
    }
  }, 30_000);
});

describe("a forge given nowhere to put a snapshot", () => {
  let root: string;
  let app: App;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "forge-outcome-none-"));
    app = createApp({ dataDir: join(root, "data"), port: 0 });
  });

  afterAll(async () => {
    app.close();
    await rm(root, { recursive: true, force: true });
  });

  test("has not failed: asking refuses, but nothing is kept, no card is raised, and nothing is retried within the hour", async () => {
    const svc = startSnapshots(app, () => undefined, { version: "t", retryMs: 50 });
    try {
      await expect(svc.now()).rejects.toThrow(/nowhere to put a snapshot/);
      expect(lastSnapshotOutcome(app.config.dataDir)).toBeUndefined();
      expect(failed(app)).toBeUndefined();
      // A short retry would have run again by now, and every run stamps `last`.
      const before = svc.last().at;
      await Bun.sleep(300);
      expect(svc.last().at).toBe(before);
    } finally {
      await svc.stop();
    }
  });
});
