/**
 * The egress table and the cell watch are kept once per process, and a
 * hosted child is a second App in its parent's process whose admin is its
 * owner (#10517): its `/metrics`, capacity listing and terminal
 * connections screen name nothing of the parent's destinations,
 * repositories or cells; the parent's still do. The gate is tested on
 * injected counters, so no proxy socket or watched process is needed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCapacity } from "../src/actions/capacity.ts";
import { createRepo } from "../src/actions/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { createApp, type App } from "../src/app.ts";
import { meterEgress, NPM_REGISTRY, recordEgress, resetEgressTotals } from "../src/apps/egress.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { markHostedChild } from "../src/spawn/hosted-mark.ts";
import {
  cellCountersFor,
  egressRowsFor,
  egressTotalsFor,
  npmBytesFor,
  npmTopRepoFor,
  type ProcessCounters,
} from "../src/spawn/process_counters.ts";
import type { Ctx } from "../src/tui/app/app.ts";
import { connectionsScreen } from "../src/tui/screens/egress.ts";
import type { Session } from "../src/tui/session.ts";
import { Screen as Surface } from "../src/tui/term/screen.ts";
import { theme } from "../src/tui/ui/theme.ts";
import { adminCookie, seedAdmin } from "./helpers/admin.ts";

const DEST = "parent-only-destination.example:443";
const CELL = "app:parent-secret-cell/production";
const NOW = 1_800_000_000_000;
const OPEN = { label: "app:parent-secret-app/production", destination: DEST, open: 2, bytesIn: 100, bytesOut: 10 };
/** Counters as the proxy and the cell watch would hold them, with no socket or process behind them. */
const fake: ProcessCounters = {
  egressRows: () => [OPEN],
  egressTotals: () => [{ destination: DEST, bytesIn: 1_000, bytesOut: 10, bytesInLastHour: 1_000 }],
  npmBytes: () => 2_000_000,
  npmTopRepo: () => ({ repoId: "r1", bytes: 2_000_000 }),
  cells: () => [{ key: 1, label: CELL, cpuUsec: 0, memoryBytes: 0, cores: null }],
};

let dir: string;
let parent: App;
let child: App;
let parentServers: Servers;
let childServers: Servers;
let parentCookie: string;
let childCookie: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "hosted-counters-"));
  parent = createApp({ dataDir: join(dir, "parent"), port: 0 });
  child = createApp({ dataDir: join(dir, "parent", "children", "kid"), port: 0 });
  markHostedChild(child, parent.config.dataDir);
  parentServers = await serve(parent);
  childServers = await serve(child);
  const owner = await seedAdmin(parent, { username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
  if (!owner.ok) throw new Error(owner.error);
  parentCookie = await adminCookie(parent, { username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  childCookie = await adminCookie(child, { username: "kidowner", email: "kid@forge.local", password: "a-good-passphrase" });
  const repo = await createRepo(parent, owner.value, { name: "parent-private-repo", visibility: "private" });
  if (!repo.ok) throw new Error(String(repo.error));
  resetEgressTotals();
  const meter = meterEgress("check:p", repo.value.id);
  recordEgress("check:p", NPM_REGISTRY, 2_000_000, 0);
  recordEgress("check:p", DEST, 1_000, 10);
  meter.stop();
}, 60_000);

afterAll(async () => {
  resetEgressTotals();
  childServers.stop();
  parentServers.stop();
  child.close();
  parent.close();
  await rm(dir, { recursive: true, force: true });
});

const get = async (s: Servers, path: string, cookie: string): Promise<string> => {
  const r = await fetch(`${s.url}${path}`, { headers: { cookie } });
  expect(r.status).toBe(200);
  return r.text();
};

describe("a hosted child's admin views", () => {
  test("/metrics names nothing of the parent's; the parent's names its destination", async () => {
    expect(await get(parentServers, "/metrics", parentCookie)).toContain(DEST);
    const body = await get(childServers, "/metrics", childCookie);
    expect(body).not.toContain(DEST);
    expect(body).not.toContain(NPM_REGISTRY);
  });

  test("the capacity listing the MCP tool reads holds none of the parent's egress", async () => {
    const admin = (a: App, name: string) => getUserByName(a.db, name)!;
    const mine = listCapacity(parent, admin(parent, "bob"));
    const theirs = listCapacity(child, admin(child, "kidowner"));
    if (!mine.ok || !theirs.ok) throw new Error("not an admin");
    expect(mine.value.egress.destinations.map((d) => d.destination)).toContain(DEST);
    expect(mine.value.egress.npmTopRepoLastHour?.repo).toBe("alice/parent-private-repo");
    expect(theirs.value.egress).toEqual({ npmBytesLastHour: 0, npmTopRepoLastHour: null, destinations: [] });
  });

  test("the open-connections rows, totals, npm bytes and top repository are the parent's alone", () => {
    expect(egressRowsFor(parent, fake)).toEqual([OPEN]);
    expect(egressRowsFor(child, fake)).toEqual([]);
    expect(egressTotalsFor(parent, NOW, fake).map((t) => t.destination)).toEqual([DEST]);
    expect(egressTotalsFor(child, NOW, fake)).toEqual([]);
    expect(npmBytesFor(parent, NOW, fake)).toBe(2_000_000);
    expect(npmBytesFor(child, NOW, fake)).toBe(0);
    expect(npmTopRepoFor(parent, NOW, fake)).toEqual({ repoId: "r1", bytes: 2_000_000 });
    expect(npmTopRepoFor(child, NOW, fake)).toBeUndefined();
  });

  test("the cell watch is the parent's alone", () => {
    expect(cellCountersFor(parent, fake).map((c) => c.label)).toEqual([CELL]);
    expect(cellCountersFor(child, fake)).toEqual([]);
  });

  test("the terminal's connections screen shows the child's admin none of the parent's connections", () => {
    const shown = (a: App, name: string): string => {
      const ctx = { theme: theme("dark"), invalidate() {} } as unknown as Ctx;
      const f = { app: a, db: a.db, user: getUserByName(a.db, name)! } as unknown as Session;
      const s = new Surface(160, 12);
      connectionsScreen(f, ctx, fake).render({ x: 0, y: 0, w: 160, h: 12 }, s);
      return s.toText();
    };
    const mine = shown(parent, "bob");
    expect(mine).toContain(OPEN.label);
    expect(mine).toContain(DEST);
    const theirs = shown(child, "kidowner");
    expect(theirs).not.toContain(OPEN.label);
    expect(theirs).not.toContain(DEST);
    expect(theirs).toContain("No app holds an egress connection open.");
  });
});
