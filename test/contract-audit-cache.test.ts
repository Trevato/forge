/**
 * `audit` keeps a repository's policy by (repository, tip): a warm read is
 * fast, and a push that changes forge.json is seen on the next read.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { repoDir } from "../src/git/repos.ts";
import { audit } from "../src/contract/audit.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { getRepo } from "../src/core/repos.ts";

let root = "";
let app: App;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "forge-audit-cache-"));
  app = createApp({ dataDir: root, port: 0 });
});
afterAll(() => {
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const contract = (read: string) =>
  JSON.stringify({
    roles: { anon: { above: [], held: { by: "everyone" } } },
    resources: {
      thing: {
        can: { create: "anon", read, update: "anon", delete: "anon", list: "anon" },
      },
    },
  });

test("a warm audit is served from the cache and a new tip is read afresh", async () => {
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  const alice = u.value;
  const made = await createRepo(app, alice, { name: "cached" });
  if (!made.ok) throw new Error(String(made.error));
  const write = async (text: string) => {
    const r = await commitToBranch(app, alice, made.value, {
      message: "policy",
      files: [{ path: "contract.json", content: text }],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  };
  const repo = () => getRepo(app.db, "alice", "cached")!;

  await write(contract("anon"));
  const first = await audit(app.reposRoot, repo());
  expect(first.standing.kind).toBe("sound");

  const warm = await audit(app.reposRoot, repo());
  expect(warm.standing).toBe(first.standing);

  await write(JSON.stringify({ roles: {}, resources: {} }));
  const changed = await audit(app.reposRoot, repo());
  expect(changed.oid).not.toBe(first.oid);
  expect(changed.standing).not.toBe(first.standing);
});

test("a packed ref takes the git path, agrees with git, and a push still invalidates", async () => {
  const alice = getUserByName(app.db, "alice")!;
  const made = await createRepo(app, alice, { name: "packed" });
  if (!made.ok) throw new Error(String(made.error));
  const write = async (text: string) => {
    const r = await commitToBranch(app, alice, made.value, {
      message: "policy",
      files: [{ path: "contract.json", content: text }],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  };
  const repo = () => getRepo(app.db, "alice", "packed")!;
  const dir = repoDir(app.reposRoot, "alice", "packed");
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", dir, ...args]).stdout.toString().trim();

  await write(contract("anon"));
  git("pack-refs", "--all");
  expect(existsSync(join(dir, "refs/heads", repo().defaultBranch))).toBe(false);

  const packed = await audit(app.reposRoot, repo());
  expect(packed.oid).toBe(git("rev-parse", `refs/heads/${repo().defaultBranch}`));
  expect(packed.standing.kind).toBe("sound");

  await write(JSON.stringify({ roles: {}, resources: {} }));
  const next = await audit(app.reposRoot, repo());
  expect(next.oid).not.toBe(packed.oid);
  expect(next.oid).toBe(git("rev-parse", `refs/heads/${repo().defaultBranch}`));
  expect(next.standing).not.toBe(packed.standing);
});
