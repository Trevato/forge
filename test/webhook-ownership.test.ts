import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  listWebhooks,
  recentDeliveries,
} from "../src/core/webhooks.ts";

describe("a webhook belongs to its repository", () => {
  let dataDir: string;
  let app: App;
  let repoA = "";
  let repoB = "";
  let hookA = "";
  let hookB = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-hook-own-"));
    app = createApp({ dataDir, port: 0 });
    const user = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "hookowner",
      email: "o@f.dev",
      password: "webhooks-are-fun",
    });
    if (!user.ok) throw new Error("user");
    for (const name of ["a", "b"]) {
      const repo = await createRepo(app.db, app.reposRoot, {
        ownerId: user.value.id,
        name,
      });
      if (!repo.ok) throw new Error("repo");
      if (name === "a") repoA = repo.value.id;
      else repoB = repo.value.id;
    }
    const a = createWebhook(app.db, { repoId: repoA, url: "https://a.example/h" });
    const b = createWebhook(app.db, { repoId: repoB, url: "https://b.example/h" });
    if (!a.ok || !b.ok) throw new Error("hook");
    hookA = a.value.webhook.id;
    hookB = b.value.webhook.id;
  });

  afterAll(async () => {
    app.close?.();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("another repository's hook is neither readable nor deletable", () => {
    expect(getWebhook(app.db, repoA, hookB)).toBeUndefined();
    expect(getWebhook(app.db, repoB, hookB)?.id).toBe(hookB);
    expect(deleteWebhook(app.db, repoA, hookB)).toBe(false);
    expect(listWebhooks(app.db, repoB).map((h) => h.id)).toEqual([hookB]);
  });

  test("listing is per repository", () => {
    expect(listWebhooks(app.db, repoA).map((h) => h.id)).toEqual([hookA]);
    expect(listWebhooks(app.db, repoB).map((h) => h.id)).toEqual([hookB]);
  });

  test("recent deliveries are only the hook's own", () => {
    app.bus.append({ kind: "push", repoId: repoA });
    app.bus.append({ kind: "push", repoId: repoB });
    app.bus.append({ kind: "push", repoId: repoB });
    expect(recentDeliveries(app.db, hookA)).toHaveLength(1);
    expect(recentDeliveries(app.db, hookB)).toHaveLength(2);
  });

  test("deleting your own removes it once", () => {
    expect(deleteWebhook(app.db, repoA, hookA)).toBe(true);
    expect(deleteWebhook(app.db, repoA, hookA)).toBe(false);
    expect(listWebhooks(app.db, repoA)).toEqual([]);
    expect(listWebhooks(app.db, repoB)).toHaveLength(1);
  });
});
