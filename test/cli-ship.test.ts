/**
 * `forge ship <number>` against a fake API: the request log is the proof.
 * No merge is requested without a yes; `--yes` merges; a refusal prints the
 * forge's own words and exits with the code a script can branch on.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, main } from "../src/cli/main.ts";
import { repoFromRemote } from "../src/cli/here.ts";
import { gitClientEnv } from "./helpers/git-client.ts";

const CLI = new URL("../src/cli/main.ts", import.meta.url).pathname;

type Merge = { status: number; body: unknown };

describe("forge ship", () => {
  let server: ReturnType<typeof Bun.serve>;
  let base = "";
  let work = "";
  let requests: string[] = [];
  let merge: Merge = { status: 200, body: {} };

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        requests.push(`${req.method} ${path}`);
        if (req.headers.get("authorization") !== "Bearer t0k")
          return Response.json({ error: "unauthorized", message: "sign in" }, { status: 401 });
        if (req.method === "GET" && path === "/api/v1/repos/alice/notes/pulls/12")
          return Response.json({
            number: 12,
            title: "Fix the \x1b[31mthing",
            state: "open",
            mergedAt: null,
            mergeable: true,
            hold: null,
          });
        if (req.method === "GET" && path === "/api/v1/repos/alice/notes/pulls/12/checks")
          return Response.json({ state: "passed" });
        if (req.method === "POST" && path === "/api/v1/repos/alice/notes/pulls/12/merge")
          return Response.json(merge.body, { status: merge.status });
        return Response.json({ error: "not_found", message: "no such pull" }, { status: 404 });
      },
    });
    base = `http://127.0.0.1:${server.port}`;
    work = await mkdtemp(join(tmpdir(), "forge-ship-"));
  });

  afterAll(async () => {
    server.stop(true);
    await rm(work, { recursive: true, force: true });
  });

  beforeEach(() => {
    requests = [];
    merge = {
      status: 200,
      body: { merged: true, mergeOid: "abcdef0123456789", carried: false },
    };
  });

  const merges = () => requests.filter((r) => r.startsWith("POST"));

  async function forge(
    args: string[],
    cwd = work,
  ): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn(["bun", CLI, ...args], {
      cwd,
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: process.env["HOME"] ?? "",
        FORGE_URL: base,
        FORGE_TOKEN: "t0k",
        FORGE_KEYCHAIN: "0",
        NO_COLOR: "1",
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

  /** `main` in this process, with the question answered by `answer`. */
  async function asked(answer: string | null, argv: string[]): Promise<{ code: number; prompts: string[] }> {
    const saved = { url: process.env["FORGE_URL"], token: process.env["FORGE_TOKEN"] };
    const write = process.stdout.write.bind(process.stdout);
    const writeErr = process.stderr.write.bind(process.stderr);
    process.env["FORGE_URL"] = base;
    process.env["FORGE_TOKEN"] = "t0k";
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    const prompts: string[] = [];
    try {
      const code = await main(argv, {
        ask: async (prompt) => {
          prompts.push(prompt);
          return answer;
        },
      });
      return { code, prompts };
    } finally {
      process.stdout.write = write;
      process.stderr.write = writeErr;
      for (const [k, v] of [["FORGE_URL", saved.url], ["FORGE_TOKEN", saved.token]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  test("without a terminal and without --yes it refuses, and asks nothing to merge", async () => {
    const r = await forge(["ship", "12", "--repo", "alice/notes"]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err.trim().split("\n")).toHaveLength(1);
    expect(r.err).toContain("--yes");
    expect(r.out).toContain("Fix the");
    expect(r.out).toContain("check passed");
    expect(r.out).toContain("mergeable");
    expect(r.out).not.toContain("\x1b");
    expect(merges()).toEqual([]);
  });

  test("anything but y at the question leaves the pull alone", async () => {
    for (const answer of ["", "n", "yes please", "N"]) {
      requests = [];
      const r = await asked(answer, ["ship", "12", "--repo", "alice/notes"]);
      expect(r.prompts).toEqual(["Ship #12? [y/N] "]);
      expect(r.code).toBe(EXIT.ok);
      expect(merges()).toEqual([]);
    }
  });

  test("y at the question merges, once", async () => {
    const r = await asked("y", ["ship", "#12", "--repo", "alice/notes"]);
    expect(r.code).toBe(EXIT.ok);
    expect(merges()).toEqual(["POST /api/v1/repos/alice/notes/pulls/12/merge"]);
  });

  test("--yes merges without asking and prints the short id and the pull's address", async () => {
    const r = await forge(["ship", "12", "--repo", "alice/notes", "--yes"]);
    expect(r.code).toBe(EXIT.ok);
    expect(merges()).toEqual(["POST /api/v1/repos/alice/notes/pulls/12/merge"]);
    expect(r.out).toContain("abcdef0");
    expect(r.out).not.toContain("abcdef01");
    expect(r.out).toContain(`${base}/alice/notes/pulls/12`);
  });

  test("a 403 prints the forge's words, exits refused, and is not retried", async () => {
    merge = {
      status: 403,
      body: { error: "forbidden", message: "agents propose; a person lands" },
    };
    const r = await forge(["ship", "12", "--repo", "alice/notes", "--yes"]);
    expect(r.code).toBe(EXIT.refused);
    expect(r.err).toContain("agents propose; a person lands");
    expect(merges()).toHaveLength(1);
  });

  test("a 409 with only a code prints that code, exits refused", async () => {
    merge = { status: 409, body: { error: "checks_required" } };
    const r = await forge(["ship", "12", "--repo", "alice/notes", "--yes"]);
    expect(r.code).toBe(EXIT.refused);
    expect(r.err).toContain("checks_required");
    expect(merges()).toHaveLength(1);
  });

  test("an unknown pull fails before any merge", async () => {
    const r = await forge(["ship", "99", "--repo", "alice/notes", "--yes"]);
    expect(r.code).toBe(EXIT.failed);
    expect(r.err).toContain("no such pull");
    expect(merges()).toEqual([]);
  });

  test("a bad number or --repo is a usage error with no request", async () => {
    for (const argv of [["ship"], ["ship", "x"], ["ship", "0"], ["ship", "12", "--repo", "a//b"]]) {
      requests = [];
      expect((await forge(argv)).code).toBe(EXIT.usage);
      expect(requests).toEqual([]);
    }
  });

  test("the repository comes from origin when it points at the workbench", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-ship-clone-"));
    try {
      const git = (args: string[]) =>
        Bun.spawn(["git", ...args], { cwd: dir, env: gitClientEnv(), stdout: "ignore", stderr: "ignore" }).exited;
      await git(["init", "-q"]);
      await git(["remote", "add", "origin", `${base}/alice/notes.git`]);
      const r = await forge(["ship", "12", "--yes"], dir);
      expect(r.code).toBe(EXIT.ok);
      expect(merges()).toEqual(["POST /api/v1/repos/alice/notes/pulls/12/merge"]);

      requests = [];
      await git(["remote", "set-url", "origin", "https://elsewhere.example/alice/notes.git"]);
      const away = await forge(["ship", "12", "--yes"], dir);
      expect(away.code).toBe(EXIT.usage);
      expect(away.err).toContain("--repo");
      expect(requests).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("remote URLs in every shape git writes, only on the workbench's host", () => {
  const wb = "https://forge.example.com";
  const want = { owner: "alice", name: "notes" };
  expect(repoFromRemote("https://forge.example.com/alice/notes.git", wb)).toEqual(want);
  expect(repoFromRemote("https://forge.example.com/alice/notes", wb)).toEqual(want);
  expect(repoFromRemote("ssh://git@forge.example.com:2222/alice/notes.git", wb)).toEqual(want);
  expect(repoFromRemote("git@forge.example.com:alice/notes.git", wb)).toEqual(want);
  expect(repoFromRemote("https://other.example.com/alice/notes.git", wb)).toBeUndefined();
  expect(repoFromRemote("https://forge.example.com/alice/notes/extra", wb)).toBeUndefined();
  expect(repoFromRemote("/local/path", wb)).toBeUndefined();
});
