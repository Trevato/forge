/**
 * `forge new` against a fake API: the request body is the proof of what was
 * asked, the folder is the proof of what was cloned, and a refusal clones
 * nothing and prints the forge's own words.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../src/cli/main.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const CLI = new URL("../src/cli/main.ts", import.meta.url).pathname;

describe("forge new", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base = "";
  let work = "";
  let source = "";
  let bodies: Record<string, unknown>[] = [];
  let refusal: { status: number; body: unknown } | null = null;
  let answer: Record<string, unknown> | null = null;
  let live: string | null = "https://notes--alice.example.test";

  const git = async (args: string[], cwd: string) => {
    const p = Bun.spawn(["git", ...args], { cwd, env: gitClientEnv(), stdout: "pipe", stderr: "pipe" });
    expect(await p.exited).toBe(0);
  };

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "forge-new-"));
    const seed = join(work, "seed");
    source = join(work, "source.git");
    await git(["init", "-q", "-b", "main", seed], work);
    await Bun.write(join(seed, "README.md"), "hello\n");
    await git(["add", "."], seed);
    await git(["commit", "-qm", "first"], seed);
    await git(["clone", "-q", "--bare", seed, source], work);
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (req.headers.get("authorization") !== "Bearer t0k")
          return Response.json({ error: "unauthorized", message: "sign in" }, { status: 401 });
        if (req.method === "POST" && path === "/api/v1/apps") {
          bodies.push((await req.json()) as Record<string, unknown>);
          if (refusal !== null) return Response.json(refusal.body, { status: refusal.status });
          if (answer !== null) return Response.json(answer, { status: 201 });
          return Response.json(
            {
              // The answer's clone URL, not one built from the typed name.
              repo: { ownerName: "alice", name: "notes", cloneUrl: source },
              app: { url: live },
              issue: null,
            },
            { status: 201 },
          );
        }
        return Response.json({ error: "not_found", message: "nope" }, { status: 404 });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    server.stop(true);
    await rm(work, { recursive: true, force: true });
  });

  let root = "";
  beforeEach(async () => {
    bodies = [];
    refusal = null;
    answer = null;
    live = "https://notes--alice.example.test";
    root = await mkdtemp(join(work, "root-"));
  });

  async function forge(args: string[]): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn(["bun", CLI, ...args, "--root", root], {
      cwd: work,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        FORGE_URL: base,
        FORGE_TOKEN: "t0k",
        FORGE_KEYCHAIN: "0",
        NO_COLOR: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, out, err };
  }

  const cloned = () => existsSync(join(root, `127.0.0.1_${server.port}`, "alice", "notes", ".git"));

  test("makes the app, clones it, prints the page and the live address", async () => {
    const r = await forge(["new", "notes", "a", "notes", "app"]);
    expect(r.code).toBe(EXIT.ok);
    expect(bodies).toEqual([{ name: "notes", description: "a notes app", visibility: "public" }]);
    expect(r.out).toContain(`${base}/alice/notes`);
    expect(r.out).toContain("https://notes--alice.example.test");
    expect(cloned()).toBe(true);
  });

  test("--private and --owner are sent", async () => {
    const r = await forge(["new", "notes", "--private", "--owner", "acme"]);
    expect(r.code).toBe(EXIT.ok);
    expect(bodies).toEqual([{ name: "notes", visibility: "private", owner: "acme" }]);
  });

  test("no live address, none printed", async () => {
    live = null;
    const r = await forge(["new", "notes"]);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out.trim().split("\n")).toHaveLength(3);
  });

  test("a refusal prints the API's words, exits refused, and clones nothing", async () => {
    for (const [status, error, message] of [
      [422, "name_taken", "you already have a repository named notes"],
      [403, "repository_limit", "you are at your repository limit"],
    ] as const) {
      refusal = { status, body: { error, message } };
      const r = await forge(["new", "notes"]);
      expect(r.code).toBe(EXIT.refused);
      expect(r.err).toContain(message);
      expect(cloned()).toBe(false);
    }
  });

  test("an owner or name that could leave the root is never cloned or printed", async () => {
    for (const ownerName of ["..", "a/b", "x\x1b[31m"]) {
      answer = { repo: { ownerName, name: "notes", cloneUrl: source }, app: null };
      const r = await forge(["new", "notes"]);
      expect(r.code).toBe(EXIT.failed);
      expect(r.err).toContain("will not clone");
      expect(r.out).toBe("");
      expect(r.err).not.toContain("\x1b");
      expect(existsSync(join(root, `127.0.0.1_${server.port}`))).toBe(false);
    }
  });

  test("made but the clone fails: says so, points at sync, exits failed", async () => {
    answer = { repo: { ownerName: "alice", name: "notes", cloneUrl: join(work, "missing.git") }, app: null };
    const r = await forge(["new", "notes"]);
    expect(r.code).toBe(EXIT.failed);
    expect(r.out).toContain("made alice/notes");
    expect(r.err).toContain("made, but not cloned");
    expect(r.err).toContain("forge sync");
    expect(cloned()).toBe(false);
  });

  test("an answer without a repository is a failure, not a crash", async () => {
    answer = { app: null };
    const r = await forge(["new", "notes"]);
    expect(r.code).toBe(EXIT.failed);
    expect(r.err).toContain("without a repository");
  });

  test("a 401 exits notConfigured and any other status exits failed", async () => {
    refusal = { status: 401, body: { error: "unauthorized", message: "token refused" } };
    let r = await forge(["new", "notes"]);
    expect(r.code).toBe(EXIT.notConfigured);
    expect(r.err).toContain("token refused");
    refusal = { status: 500, body: { error: "boom", message: "it broke" } };
    r = await forge(["new", "notes"]);
    expect(r.code).toBe(EXIT.failed);
    expect(r.err).toContain("it broke");
    expect(cloned()).toBe(false);
  });

  test("an empty name is usage and asks nothing of the forge", async () => {
    const r = await forge(["new"]);
    expect(r.code).toBe(EXIT.usage);
    expect(bodies).toEqual([]);
  });
});
