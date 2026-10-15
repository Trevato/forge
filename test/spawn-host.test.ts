/**
 * Hosted children are reached by Host `<name>--<parentHost>` on the parent
 * listener (# hosted-child forge reachability).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { childDirOf, spawnForge } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { flushAccess } from "../src/http/access_log.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("hosted child Host dispatch", () => {
  let dir = "";
  let parent: App;
  let servers: Servers;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-spawn-host-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const made = await createUser(parent.db, {
      trusted: true,
      username: "alice",
      email: "a@x.invalid",
      isAdmin: true,
    });
    if (!made.ok) throw new Error("user");
    const spawned = await spawnForge(
      parent,
      made.value,
      { name: "homie", org: "homie", apps: [], carryBriefs: false, carrySubscriptions: false },
      { catalog: [], briefs: [], subscriptions: [] },
      {
        placement: hostedPlacement({ host: "forge.test" }),
        request: new Request("https://forge.test/spawn", {
          method: "POST",
          headers: { origin: "https://forge.test" },
        }),
        url: new URL("https://forge.test/spawn"),
      },
    );
    if (!spawned.ok) throw new Error(JSON.stringify(spawned.error));
    expect(spawned.value.url).toBe("https://homie--forge.test");
    servers = await serve(parent);
  });

  afterAll(() => {
    servers?.stop();
    parent?.close();
    return rm(dir, { recursive: true, force: true });
  });

  test("parent Host still serves the parent", async () => {
    const res = await fetch(servers.url + "/healthz", {
      headers: { host: "forge.test" },
    });
    expect(res.status).toBe(200);
  });

  test("child Host reaches the child's forge", async () => {
    const res = await fetch(servers.url + "/healthz", {
      headers: { host: "homie--forge.test" },
    });
    expect(res.status).toBe(200);
    const unknown = await fetch(servers.url + "/healthz", {
      headers: { host: "nope--forge.test" },
    });
    expect(unknown.status).toBe(404);
  });

  test("a child's requests are logged in the child's data, never the parent's", async () => {
    const ask = (host: string, path: string) =>
      fetch(servers.url + path, {
        headers: { host, "user-agent": "VisitorBot/1.0" },
      });
    await ask("homie--forge.test", "/api/in-the-childs-house");
    await ask("forge.test", "/api/in-the-parents-house");
    flushAccess();
    const { bodyId } = JSON.parse(
      readFileSync(join(dir, "spawn", "homie.json"), "utf8"),
    ) as { bodyId: string };
    const paths = (dataDir: string): string[] =>
      readdirSync(join(dataDir, "access")).flatMap((f) =>
        readFileSync(join(dataDir, "access", f), "utf8")
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => (JSON.parse(l) as { path: string }).path),
      );
    expect(paths(childDirOf(parent, bodyId))).toEqual(["/api/in-the-childs-house"]);
    expect(paths(dir)).toEqual(["/api/in-the-parents-house"]);
  });
});
