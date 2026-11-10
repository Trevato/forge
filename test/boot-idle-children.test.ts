/**
 * Children the boot opened so their apps come back, and nobody has asked for,
 * do not count against the awake ceiling: a person's wake is never refused
 * because of forges nobody is using.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnForge } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { awakeCount, bootHostedChildren, childAwake, resolveHostedChild, sleepChild, sleepIdleChildren, wakeGate } from "../src/spawn/host.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let parent: App;
let was: string | undefined;

beforeAll(async () => {
  was = process.env["FORGE_CHILD_AWAKE_MAX"];
  dir = await mkdtemp(join(tmpdir(), "boot-idle-"));
  parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  const made = await createUser(parent.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.invalid", isAdmin: true });
  if (!made.ok) throw new Error("user");
  for (const name of ["idle-a", "idle-b", "sleeper"]) {
    const spawned = await spawnForge(
      parent,
      made.value,
      { name, org: name, apps: [], carryBriefs: false, carrySubscriptions: false },
      { catalog: [], briefs: [], subscriptions: [] },
      {
        placement: hostedPlacement({ host: "forge.test" }),
        request: new Request("https://forge.test/spawn", { method: "POST", headers: { origin: "https://forge.test" } }),
        url: new URL("https://forge.test/spawn"),
      },
    );
    if (!spawned.ok) throw new Error(JSON.stringify(spawned.error));
  }
});

afterAll(async () => {
  if (was === undefined) delete process.env["FORGE_CHILD_AWAKE_MAX"];
  else process.env["FORGE_CHILD_AWAKE_MAX"] = was;
  parent.close();
  await rm(dir, { recursive: true, force: true });
});

test("a wake is not refused for children the boot opened and nobody asked for", async () => {
  await sleepIdleChildren(parent, 0, Date.now() + 3_600_000);
  process.env["FORGE_CHILD_AWAKE_MAX"] = "2";
  await bootHostedChildren(parent);
  expect(childAwake(parent, "idle-a")).toBe(true);
  expect(childAwake(parent, "idle-b")).toBe(true);
  await sleepChild(parent, "sleeper");
  expect(childAwake(parent, "sleeper")).toBe(false);
  expect(awakeCount(parent)).toBe(0);
  const refused = wakeGate(parent, new Request("https://forge.test/", { headers: { host: "sleeper--forge.test" } }));
  expect(refused).toBeUndefined();
});

const hostOf = (name: string) => `${name}--forge.test`;
const gate = (name: string, headers: Record<string, string> = {}) =>
  wakeGate(parent, new Request("https://forge.test/", { headers: { host: hostOf(name), ...headers } }));
const reset = async () => {
  await sleepIdleChildren(parent, 0, Date.now() + 3_600_000);
  process.env["FORGE_CHILD_AWAKE_MAX"] = "2";
  await bootHostedChildren(parent);
};

test("a boot-opened child a credentialed request reaches counts again, and the ceiling then holds", async () => {
  await reset();
  expect(awakeCount(parent)).toBe(0);
  const child = (await resolveHostedChild(parent, new Request("https://forge.test/healthz", { headers: { host: hostOf("idle-a") } }))) as App;
  const made = await createUser(child.db, { origin: "seed", trusted: true, username: "carol", email: "c@x.invalid", isAdmin: false });
  if (!made.ok) throw new Error("user");
  const { token } = createSession(child.db, made.value.id);
  expect(gate("idle-a", { cookie: `forge_session=${token}` })).toBeUndefined();
  expect(awakeCount(parent)).toBe(1);
  // A made-up cookie asks for nothing: idle-b stays uncounted.
  expect(gate("idle-b", { cookie: "forge_session=made-up" })).toBeUndefined();
  expect(awakeCount(parent)).toBe(1);
  await sleepChild(parent, "sleeper");
  await sleepChild(parent, "idle-b");
  // One asked-for forge is awake and one wake is granted: the ceiling of 2 is full.
  expect(gate("sleeper")).toBeUndefined();
  expect(awakeCount(parent)).toBe(2);
  const refused = gate("idle-b");
  expect(refused?.status).toBe(429);
});

test("an unasked boot-opened child put to sleep leaves the exempt set, so its next wake counts", async () => {
  await reset();
  expect(awakeCount(parent)).toBe(0);
  await sleepChild(parent, "idle-b");
  await resolveHostedChild(parent, new Request("https://forge.test/healthz", { headers: { host: hostOf("idle-b") } }));
  expect(childAwake(parent, "idle-b")).toBe(true);
  expect(awakeCount(parent)).toBe(1); // reopened by a request, not by the boot: counted
  await sleepChild(parent, "idle-b");
  expect(awakeCount(parent)).toBe(0);
});
