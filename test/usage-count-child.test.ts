/** A hosted child's requests are counted in the child's database (#1918). */

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childDirOf, spawnForge } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { readUsage } from "../src/core/usage_count.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { resolveHostedChild } from "../src/spawn/host.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let parent: App;
let servers: Servers;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-usage-child-"));
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
  servers = await serve(parent);
});

afterAll(() => rm(dir, { recursive: true, force: true }));

test("the child's request lands in the child's usage_count, not the parent's", async () => {
  await fetch(servers.url + "/healthz", { headers: { host: "homie--forge.test" } });
  await fetch(servers.url + "/healthz", { headers: { host: "homie--forge.test" } });
  await fetch(servers.url + "/readyz", { headers: { host: "forge.test" } });
  // A throw in the child is the child's 500, counted in the child.
  const host = { headers: { host: "homie--forge.test" } };
  const kid = await resolveHostedChild(parent, new Request("http://x/", host));
  if (typeof kid === "string" || kid === undefined) throw new Error("child");
  const real = kid.db.query.bind(kid.db);
  const broken = spyOn(kid.db, "query").mockImplementation(((sql: string) => {
    if (/FROM\s+repo\b/i.test(sql)) throw new Error("disk on fire");
    return real(sql);
  }) as never);
  const boom = await fetch(servers.url + "/api/v1/repos/alice/x/issues/1", host);
  broken.mockRestore();
  expect(boom.status).toBe(500);
  servers.stop();
  const { bodyId } = JSON.parse(
    readFileSync(join(dir, "spawn", "homie.json"), "utf8"),
  ) as { bodyId: string };
  const child = new Database(join(childDirOf(parent, bodyId), "forge.db"), { readonly: true });
  const inChild = readUsage(child, "");
  const inParent = readUsage(parent.db, "");
  child.close();
  parent.close();
  expect(inChild.map((r) => [r.pattern, r.n])).toEqual([
    ["/api/v1/repos/:owner/:name/issues/:number", 1],
    ["/healthz", 2],
  ]);
  expect(inChild.find((r) => r.status === "5xx")?.pattern).toBe(
    "/api/v1/repos/:owner/:name/issues/:number",
  );
  expect(inParent.map((r) => [r.pattern, r.n])).toEqual([["/readyz", 1]]);
});
