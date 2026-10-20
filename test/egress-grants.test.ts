/**
 * A granted private destination in forge.json egress lets a cell reach
 * exactly that address:port (#3432): declared, granted, pinned; never wider.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { decide, type EgressPolicy } from "../src/apps/egress.ts";
import { parseManifest } from "../src/apps/manifest.ts";
import { grantedFor } from "../src/apps/runtime.ts";
import { grantEgress, listEgressGrants, revokeEgress } from "../src/core/egress_grants.ts";
import { createUser } from "../src/core/users.ts";

let app: App;
let dir: string;
let repoId: string;
let admin: { id: string; isAdmin: boolean };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "egress-grants-"));
  app = createApp({ dataDir: dir, port: 0 });
  const user = await createUser(app.db, { origin: "seed", trusted: true, username: "ada", email: "a@f.dev", password: "grants-are-exact" });
  if (!user.ok) throw new Error("user");
  admin = { id: user.value.id, isAdmin: true };
  const repo = await createRepo(app.db, app.reposRoot, { ownerId: user.value.id, name: "arm" });
  if (!repo.ok) throw new Error("repo");
  repoId = repo.value.id;
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const policy = (hosts: string[], granted: string[] = []): EgressPolicy => ({ hosts, origins: [], granted });

describe("forge.json egress and private destinations", () => {
  const read = (egress: unknown) => parseManifest(JSON.stringify({ app: { run: "bun x" }, egress }), undefined);
  test("an exact private address:port is accepted", () => {
    expect(read(["100.89.95.68:8101"]).ok).toBe(true);
  });
  test("a range, a wildcard or a portless private entry is refused, with words", () => {
    for (const bad of ["10.0.0.0/8", "*.100.89.95.68", "*.10.0.0.1:80", "100.89.95.68", "192.168.1.1"]) {
      const r = read([bad]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(JSON.stringify(r.error)).toMatch(/private address|never a range/);
    }
  });
  test("an IPv6 literal, private or not, is refused: egress takes IPv4 and names", () => {
    for (const bad of ["fd00::1", "[fd00::1]:8101", "::1", "[::1]:80"])
      expect(read([bad]).ok).toBe(false);
  });
  test("a public address without a port is still fine", () => {
    expect(read(["8.8.8.8"]).ok).toBe(true);
  });
});

describe("the grants table", () => {
  test("grant, list, revoke: who and when", () => {
    const g = grantEgress(app.db, repoId, "100.89.95.68:8101", admin);
    expect(g.ok).toBe(true);
    const list = listEgressGrants(app.db, repoId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ destination: "100.89.95.68:8101", grantedBy: admin.id });
    expect(list[0]?.grantedAt).toMatch(/^\d{4}-/);
    expect(revokeEgress(app.db, repoId, "100.89.95.68:8101", admin)).toBe(true);
    expect(listEgressGrants(app.db, repoId)).toEqual([]);
  });
  test("only a site admin grants", () => {
    expect(grantEgress(app.db, repoId, "100.89.95.68:8101", { id: admin.id, isAdmin: false }).ok).toBe(false);
  });
  test("a range, a wildcard or a portless destination cannot be granted", () => {
    for (const bad of ["10.0.0.0/8:80", "*.example.com:80", "100.89.95.68", "100.89.95.68:0", "100.89.95.68:70000"])
      expect(grantEgress(app.db, repoId, bad, admin).ok).toBe(false);
  });
  test("the metadata service, loopback and the forge's cluster can never be granted", () => {
    for (const bad of ["169.254.169.254:80", "169.254.1.1:80", "127.0.0.1:8080", "10.42.3.4:80", "10.43.0.1:443"]) {
      const r = grantEgress(app.db, repoId, bad, admin);
      expect(r.ok).toBe(false);
    }
    expect(listEgressGrants(app.db, repoId)).toEqual([]);
  });
});

describe("the proxy's verdict", () => {
  test("declared and granted connects, pinned to the granted address", async () => {
    const v = await decide(policy(["100.89.95.68:8101"], ["100.89.95.68:8101"]), "100.89.95.68", 8101);
    expect(v).toEqual({ ok: true, address: "100.89.95.68", undeclared: false });
  });
  test("declared but not granted is refused, saying what to do", async () => {
    const v = await decide(policy(["100.89.95.68:8101"]), "100.89.95.68", 8101);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.why).toContain("add it to forge.json egress and ask a site admin to grant it");
  });
  test("granted but not declared is refused", async () => {
    const v = await decide(policy([], ["100.89.95.68:8101"]), "100.89.95.68", 8101);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.why).toContain("ask a site admin to grant it");
  });
  test("a grant on :8101 does not open :22, nor another address", async () => {
    const p = policy(["100.89.95.68:8101", "100.89.95.68:22"], ["100.89.95.68:8101"]);
    expect((await decide(p, "100.89.95.68", 22)).ok).toBe(false);
    expect((await decide(p, "100.89.95.69", 8101)).ok).toBe(false);
  });
  test("a wildcard entry declares a name but never makes it grantable", async () => {
    const p = policy(["*.localhost:8101"], ["a.localhost:8101"]);
    expect((await decide(p, "a.localhost", 8101)).ok).toBe(false);
  });
  test("a name that resolves to the metadata address is refused even if granted", async () => {
    const v = await decide(policy(["localhost:8101"], ["localhost:8101"]), "localhost", 8101);
    expect(v.ok).toBe(false);
  });
  test("a public host is unaffected", async () => {
    const v = await decide(policy(["8.8.8.8"]), "8.8.8.8", 443);
    expect(v.ok).toBe(true);
  });
});

describe("from a stored grant to the proxy policy", () => {
  test("grantedFor reads what an admin stored, and the verdict follows it", async () => {
    const hosts = ["100.89.95.68:8101"];
    const before = { hosts, origins: [], granted: grantedFor(app.db, repoId) };
    expect((await decide(before, "100.89.95.68", 8101)).ok).toBe(false);
    grantEgress(app.db, repoId, "100.89.95.68:8101", admin);
    const after = { hosts, origins: [], granted: grantedFor(app.db, repoId) };
    expect(after.granted).toEqual(["100.89.95.68:8101"]);
    expect((await decide(after, "100.89.95.68", 8101)).ok).toBe(true);
    revokeEgress(app.db, repoId, "100.89.95.68:8101", admin);
    expect(grantedFor(app.db, repoId)).toEqual([]);
  });
  test("a grant belongs to its repository alone", () => {
    grantEgress(app.db, repoId, "100.89.95.68:8101", admin);
    expect(grantedFor(app.db, "some-other-repo")).toEqual([]);
    revokeEgress(app.db, repoId, "100.89.95.68:8101", admin);
  });
});
