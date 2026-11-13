import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outboundFetch, RefusedError, vetHost } from "../src/kernel/outbound.ts";
import {
  fetchMirror,
  MIRROR_REFUSED,
  provideMirrorOutboundForTest,
} from "../src/origins/git-mirror.ts";
import {
  isTrustedHost,
  loadTrustedHosts,
  parseHostList,
  saveTrustedHosts,
  trustedHosts,
} from "../src/origins/trusted-hosts.ts";

const inCluster = async () => ["10.43.191.15"];

afterEach(() => {
  loadTrustedHosts(undefined, {});
  provideMirrorOutboundForTest({ allow: ["127.0.0.1", "::1"] });
});

test("a host resolving to 10.x is refused by default and passes once trusted by name", async () => {
  const host = "git.open-platform.sh";
  expect(await vetHost(host, { resolve: inCluster })).toEqual({ ok: false, error: "refused" });
  const trusted = await vetHost(host, { resolve: inCluster, trusted: [host] });
  expect(trusted).toEqual({ ok: true, value: { via: "pin", addresses: ["10.43.191.15"] } });
  // Exact name only: a sibling or a subdomain is not the host.
  for (const other of ["evil.open-platform.sh", `x.${host}`, "open-platform.sh"])
    expect(await vetHost(other, { resolve: inCluster, trusted: [host] })).toEqual({
      ok: false,
      error: "refused",
    });
  // Never by address.
  expect(await vetHost("10.43.191.15", { trusted: ["10.43.191.15"] })).toEqual({
    ok: false,
    error: "refused",
  });
});

test("origin sync to a trusted host gets past the vet; an untrusted one is refused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trusted-"));
  try {
    provideMirrorOutboundForTest({ resolve: inCluster });
    const refused = await fetchMirror(dir, "https://git.open-platform.sh/a/b.git", {});
    expect(!refused.ok && refused.error.message).toBe(MIRROR_REFUSED);

    loadTrustedHosts(undefined, { FORGE_OUTBOUND_TRUSTED_HOSTS: "git.open-platform.sh" });
    const past = await fetchMirror(dir, "https://git.open-platform.sh/a/b.git", {});
    // Not a repository, so git itself fails — but not the refusal.
    expect(!past.ok && past.error.message).not.toBe(MIRROR_REFUSED);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a webhook to a trusted host is still refused", async () => {
  loadTrustedHosts(undefined, { FORGE_OUTBOUND_TRUSTED_HOSTS: "git.open-platform.sh" });
  expect(isTrustedHost("git.open-platform.sh")).toBe(true);
  await expect(
    outboundFetch("https://git.open-platform.sh/hook", {}, { resolve: inCluster }),
  ).rejects.toBeInstanceOf(RefusedError);
});

test("the list keeps only host names, from the environment and the admin's row", () => {
  expect(parseHostList("Git.Example.test, 10.0.0.1 https://x.test *.y.test\nlocalhost a_b")).toEqual([
    "git.example.test",
    "localhost",
  ]);
  const db = new Database(":memory:");
  db.run(`CREATE TABLE forge_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_by TEXT, updated_at TEXT);
    CREATE TABLE forge_setting_change (key TEXT, from_value TEXT, to_value TEXT, actor_id TEXT, at TEXT)`);
  loadTrustedHosts(db, { FORGE_OUTBOUND_TRUSTED_HOSTS: "a.test" });
  saveTrustedHosts(db, ["b.test"], "u1");
  expect(trustedHosts().sort()).toEqual(["a.test", "b.test"]);
  loadTrustedHosts(db, {});
  expect(trustedHosts()).toEqual(["b.test"]);
});
