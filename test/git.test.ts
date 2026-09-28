import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isSafeName,
  isSafeOid,
  isSafeRef,
  isSafeTreePath,
} from "../src/git/guard.ts";
import {
  commitLog,
  headBranch,
  listRefs,
  listTree,
  RepoReader,
} from "../src/git/read.ts";
import {
  deleteRepoDir,
  initBareRepo,
  repoDir,
  repoExists,
} from "../src/git/repos.ts";
import {
  advertiseRefs,
  isGitService,
  serviceRpc,
} from "../src/git/smart-http.ts";
import { unwrap } from "../src/kernel/result.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

// Client-side git for driving the server under test.
const clientEnv = gitClientEnv({
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@forge.local",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@forge.local",
});

async function sh(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(args, {
    cwd,
    env: clientEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, errText, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0)
    throw new Error(`${args.join(" ")} failed (${code}): ${errText}`);
  return out.trim();
}

describe("guard", () => {
  test("names", () => {
    for (const good of ["app", "my-repo", "a.b_c", "X1"])
      expect(isSafeName(good)).toBe(true);
    for (const bad of [
      "",
      "-flag",
      ".hidden",
      "a/b",
      "a..b",
      "x.git",
      "x.lock",
      "a b",
      "a\0b",
    ]) {
      expect(isSafeName(bad)).toBe(false);
    }
  });

  test("refs", () => {
    for (const good of ["main", "refs/heads/main", "feature/x-1", "v1.0.0"]) {
      expect(isSafeRef(good)).toBe(true);
    }
    for (const bad of [
      "",
      "-x",
      "--exec=evil",
      "a..b",
      "a//b",
      "/lead",
      "trail/",
      "a b",
      "a~1",
      "a^2",
      "a:b",
      "a?",
      "a*",
      "a[b",
      "a\\b",
      "@",
      "a@{1}",
      ".dot",
      "dot.",
      "x.lock",
      "seg/.hidden",
    ]) {
      expect(isSafeRef(bad)).toBe(false);
    }
  });

  test("oids and tree paths", () => {
    expect(isSafeOid("a".repeat(40))).toBe(true);
    expect(isSafeOid("a".repeat(39))).toBe(false);
    expect(isSafeOid("Z".repeat(40))).toBe(false);
    expect(isSafeTreePath("src/index.ts")).toBe(true);
    expect(isSafeTreePath("/abs")).toBe(false);
    expect(isSafeTreePath("a/../b")).toBe(false);
    expect(isSafeTreePath("a//b")).toBe(false);
  });

  test("repoDir refuses traversal outright", () => {
    expect(() => repoDir("/data", "..", "x")).toThrow();
    expect(() => repoDir("/data", "alice", "../../etc")).toThrow();
  });
});

describe("smart http end to end", () => {
  let root: string;
  let work: string;
  let server: ReturnType<typeof Bun.serve>;
  let base: string;
  let bare: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "forge-repos-"));
    work = await mkdtemp(join(tmpdir(), "forge-work-"));
    bare = repoDir(root, "alice", "app");
    unwrap(await initBareRepo(bare));

    // The minimal router a git client needs — auth arrives in a later layer.
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        const advertise = url.pathname.match(
          /^\/([^/]+)\/([^/]+)\.git\/info\/refs$/,
        );
        if (advertise && request.method === "GET") {
          const service = url.searchParams.get("service");
          if (!isGitService(service))
            return new Response("dumb http unsupported", { status: 400 });
          return advertiseRefs(
            repoDir(root, advertise[1]!, advertise[2]!),
            service,
            request,
          );
        }
        const rpc = url.pathname.match(
          /^\/([^/]+)\/([^/]+)\.git\/(git-upload-pack|git-receive-pack)$/,
        );
        if (rpc && request.method === "POST") {
          return serviceRpc(
            repoDir(root, rpc[1]!, rpc[2]!),
            rpc[3] as never,
            request,
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  });

  test("clone an empty repo", async () => {
    await sh(["git", "clone", `${base}/alice/app.git`, "empty"], work);
    const branch = await sh(
      ["git", "-C", "empty", "symbolic-ref", "--short", "HEAD"],
      work,
    );
    expect(branch).toBe("main");
  });

  test("push, then clone back with content intact", async () => {
    const dir = join(work, "empty");
    await Bun.write(join(dir, "hello.txt"), "hello forge\n");
    await sh(["git", "add", "."], dir);
    await sh(["git", "commit", "-m", "first light"], dir);
    await sh(["git", "push", "origin", "main"], dir);

    const refs = unwrap(await listRefs(bare));
    expect(refs.some((r) => r.name === "refs/heads/main")).toBe(true);

    await sh(["git", "clone", `${base}/alice/app.git`, "verify"], work);
    const content = await Bun.file(join(work, "verify", "hello.txt")).text();
    expect(content).toBe("hello forge\n");
  });

  test("second push shows up in log, tree, and reader", async () => {
    const dir = join(work, "empty");
    await Bun.write(join(dir, "src/lib.ts"), "export const answer = 42;\n");
    await sh(["git", "add", "."], dir);
    await sh(["git", "commit", "-m", "add lib"], dir);
    await sh(["git", "push"], dir);

    const log = unwrap(await commitLog(bare, "main"));
    expect(log.length).toBe(2);
    expect(log[0]?.subject).toBe("add lib");
    expect(log[1]?.subject).toBe("first light");
    expect(log[0]?.parents).toEqual([log[1]!.oid]);

    const rootTree = unwrap(await listTree(bare, "main", ""));
    expect(rootTree.map((e) => e.name)).toEqual(["src", "hello.txt"]);
    expect(rootTree[0]?.type).toBe("tree");

    const sub = unwrap(await listTree(bare, "main", "src"));
    expect(sub[0]?.name).toBe("lib.ts");

    expect(unwrap(await headBranch(bare))).toBe("main");

    const reader = new RepoReader(bare);
    try {
      const blob = unwrap(await reader.object("main:hello.txt"));
      expect(blob.type).toBe("blob");
      expect(new TextDecoder().decode(blob.body)).toBe("hello forge\n");

      const stat = unwrap(await reader.stat("main:src/lib.ts"));
      expect(stat.type).toBe("blob");
      expect(stat.size).toBe("export const answer = 42;\n".length);

      const missing = await reader.object("main:nope.txt");
      expect(missing.ok).toBe(false);
    } finally {
      reader.close();
    }
  });

  test("reader survives concurrent hammering", async () => {
    const reader = new RepoReader(bare);
    try {
      const results = await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          i % 2 === 0
            ? reader.object("main:hello.txt")
            : reader.object("main:src/lib.ts"),
        ),
      );
      for (const [i, result] of results.entries()) {
        expect(result.ok).toBe(true);
        if (!result.ok) continue;
        const text = new TextDecoder().decode(result.value.body);
        expect(text).toBe(
          i % 2 === 0 ? "hello forge\n" : "export const answer = 42;\n",
        );
      }
    } finally {
      reader.close();
    }
  });

  test("fetch over the wire after more history (protocol v2 negotiation)", async () => {
    const dir = join(work, "verify");
    await sh(["git", "pull"], dir);
    const content = await Bun.file(join(dir, "src/lib.ts")).text();
    expect(content).toBe("export const answer = 42;\n");
  });

  test("repo lifecycle: exists and delete", async () => {
    const scratch = repoDir(root, "alice", "scratch");
    expect(await repoExists(scratch)).toBe(false);
    unwrap(await initBareRepo(scratch));
    expect(await repoExists(scratch)).toBe(true);
    unwrap(await deleteRepoDir(scratch));
    expect(await repoExists(scratch)).toBe(false);
    expect(() => deleteRepoDir(join(root, "alice"))).toThrow();
  });
});
