/**
 * `forge search` against a fake `/api/v1/search`: the CLI run as a shell
 * runs it, a process reading only its environment, so the exit codes are real.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, searchLines } from "../src/cli/main.ts";

const CLI = new URL("../src/cli/main.ts", import.meta.url).pathname;

const ANSWER = {
  repos: [
    {
      source: "local", id: "r1", owner: "alice", name: "shop", description: "A shop that retries",
      visibility: "public", archived: false, openIssues: 1, openPulls: 1,
    },
  ],
  issues: [
    {
      source: "local", repo: { owner: "alice", name: "shop" }, number: 7, kind: "issue",
      title: "Retry budget runs out", state: "open", updatedAt: "2026-10-01T00:00:00Z",
    },
    {
      source: "local", repo: { owner: "alice", name: "shop" }, number: 12, kind: "pull",
      title: "Retry with a budget", state: "closed", updatedAt: "2026-10-02T00:00:00Z",
    },
    {
      source: "origin", originId: "o1", fullName: "bob/upstream", number: 300, kind: "issue",
      title: `Retry ${"and retry again ".repeat(8)}end`, state: "closed",
      updatedAt: "2026-10-03T00:00:00Z", htmlUrl: "https://elsewhere.example/bob/upstream/issues/300",
    },
  ],
  code: [
    {
      repo: { owner: "alice", name: "shop" }, archived: false, path: "src/retry.ts", line: 14,
      text: "    const budget = retry(attempts);",
    },
    {
      repo: { owner: "alice", name: "shop" }, archived: false, path: "src/very/deep/path/client.ts",
      line: 2031, text: `// retry ${"x".repeat(200)}`,
    },
  ],
  truncated: { repos: false, issues: false, code: false },
  moreCode: false,
  codeSkipped: false,
};

const EMPTY = {
  repos: [], issues: [], code: [],
  truncated: { repos: false, issues: false, code: false },
  moreCode: false, codeSkipped: false,
};

let server: ReturnType<typeof Bun.serve>;
let base = "";
let configDir = "";
let reply: () => Response = () => Response.json(ANSWER);
const seen: URL[] = [];

beforeAll(async () => {
  configDir = await mkdtemp(join(tmpdir(), "forge-search-"));
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push(url);
      return url.pathname === "/api/v1/search" && req.headers.get("authorization") === "Bearer tok"
        ? reply()
        : Response.json({ error: "not_found", message: "no" }, { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server.stop(true);
  await rm(configDir, { recursive: true, force: true });
});

async function forge(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      FORGE_URL: base,
      FORGE_TOKEN: "tok",
      FORGE_CONFIG_DIR: configDir,
      FORGE_KEYCHAIN: "0",
      NO_COLOR: "1",
    },
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

test("the words become q; --kind and --limit pass through, and the forge's defaults stand otherwise", async () => {
  reply = () => Response.json(ANSWER);
  await forge(["search", "retry", "budget"]);
  const plain = seen.at(-1)!;
  expect(plain.searchParams.get("q")).toBe("retry budget");
  expect(plain.searchParams.has("kind")).toBe(false);
  expect(plain.searchParams.has("limit")).toBe(false);

  await forge(["search", "retry", "--kind", "code", "--limit", "5"]);
  const narrowed = seen.at(-1)!;
  expect(narrowed.searchParams.get("q")).toBe("retry");
  expect(narrowed.searchParams.get("kind")).toBe("code");
  expect(narrowed.searchParams.get("limit")).toBe("5");

  // The API answers pulls inside `issues`; the CLI asks for that, at the
  // API's ceiling, and cuts to --limit itself after keeping the one kind.
  await forge(["search", "retry", "--kind", "pulls", "--limit", "3"]);
  expect(seen.at(-1)!.searchParams.get("kind")).toBe("issues");
  expect(seen.at(-1)!.searchParams.get("limit")).toBe("100");
});

/** Hits as the forge orders them: issues first, so a window of 1 holds no pull. */
const MIXED = {
  ...EMPTY,
  issues: [1, 2, 3, 4].map((n) => ({
    source: "local", repo: { owner: "alice", name: "shop" }, number: n,
    kind: n <= 2 ? "issue" : "pull", title: `Retry ${n}`, state: "open",
    updatedAt: "2026-10-01T00:00:00Z",
  })),
};

/** A fake that honours `limit` as the forge does: the first N hits. */
function windowed(answer: typeof MIXED): () => Response {
  return () => {
    const limit = Number(seen.at(-1)!.searchParams.get("limit") ?? "20");
    return Response.json({ ...answer, issues: answer.issues.slice(0, limit) });
  };
}

test("--kind pulls --limit 1 prints a pull even when the forge ranks issues first", async () => {
  reply = windowed(MIXED);
  const pulls = await forge(["search", "retry", "--kind", "pulls", "--limit", "1"]);
  expect(pulls.code).toBe(EXIT.ok);
  expect(pulls.out).toBe("pulls (1, more not shown)\nalice/shop#3  Retry 3  open\n");

  const issues = await forge(["search", "retry", "--kind", "issues", "--limit", "2"]);
  expect(issues.out).toBe("issues (2)\nalice/shop#1  Retry 1  open\nalice/shop#2  Retry 2  open\n");

  // --json is the same narrowed answer, and says the list was cut.
  const json = await forge(["search", "retry", "--kind", "pulls", "--limit", "1", "--json"]);
  const body = JSON.parse(json.out);
  expect(body.issues.map((i: { number: number }) => i.number)).toEqual([3]);
  expect(body.truncated).toEqual({ repos: false, issues: true, code: false });
  const whole = await forge(["search", "retry", "--kind", "pulls", "--json"]);
  expect(JSON.parse(whole.out).truncated.issues).toBe(false);
});

test("prints code as owner/name:path:line and conversations as owner/name#N, each group headed", async () => {
  reply = () => Response.json(ANSWER);
  const run = await forge(["search", "retry"]);
  expect(run.code).toBe(EXIT.ok);
  const lines = run.out.trimEnd().split("\n");
  expect(lines[0]).toBe("code (2)");
  expect(lines[1]).toBe("alice/shop:src/retry.ts:14  const budget = retry(attempts);");
  expect(lines[2]!.startsWith("alice/shop:src/very/deep/path/client.ts:2031  // retry xxx")).toBe(true);
  expect(lines[2]!.endsWith("…")).toBe(true);
  expect(lines[3]).toBe("");
  expect(lines[4]).toBe("issues (2)");
  expect(lines[5]!.startsWith("alice/shop#7      Retry budget runs out  ")).toBe(true);
  expect(lines[5]!.endsWith("  open")).toBe(true);
  expect(lines[6]!.startsWith("bob/upstream#300  Retry and retry again")).toBe(true);
  expect(lines[6]!.endsWith("…  closed")).toBe(true);
  expect(lines[8]).toBe("pulls (1)");
  expect(lines[9]).toBe("alice/shop#12  Retry with a budget  closed");
  expect(lines[11]).toBe("repos (1)");
  expect(lines[12]).toBe("alice/shop  A shop that retries");
  // A pipe has no width; the CLI takes 80 and leaves the last column free.
  for (const line of lines) expect(line.length).toBeLessThanOrEqual(79);
});

test("--kind keeps one group; --json prints the answer unchanged", async () => {
  reply = () => Response.json(ANSWER);
  const pulls = await forge(["search", "retry", "--kind", "pulls"]);
  expect(pulls.out).toBe("pulls (1)\nalice/shop#12  Retry with a budget  closed\n");

  const json = await forge(["search", "retry", "--json"]);
  expect(json.code).toBe(EXIT.ok);
  expect(JSON.parse(json.out)).toEqual(ANSWER);
});

test("no hit prints one sentence and exits 0", async () => {
  reply = () => Response.json(EMPTY);
  const run = await forge(["search", "nothing", "here"]);
  expect(run.code).toBe(EXIT.ok);
  expect(run.out).toBe('Nothing found for "nothing here".\n');
});

test("a 429 prints the API's words with its retry time and exits rateLimited", async () => {
  reply = () =>
    Response.json(
      { error: "rate_limited", message: "Too many code searches" },
      { status: 429, headers: { "retry-after": "17" } },
    );
  const run = await forge(["search", "retry"]);
  expect(run.code).toBe(EXIT.rateLimited);
  expect(run.err).toBe("forge search: Too many code searches (retry in 17s)\n");

  // When the words already name the time, it is not said twice.
  reply = () =>
    Response.json(
      { error: "rate_limited", message: "busy; sign in, or retry in 9s" },
      { status: 429, headers: { "retry-after": "9" } },
    );
  const named = await forge(["search", "retry"]);
  expect(named.code).toBe(EXIT.rateLimited);
  expect(named.err).toBe("forge search: busy; sign in, or retry in 9s\n");

  // 117s is not 17s: the time is matched as a whole word.
  reply = () =>
    Response.json(
      { error: "rate_limited", message: "busy; retry in 117s" },
      { status: 429, headers: { "retry-after": "17" } },
    );
  const other = await forge(["search", "retry"]);
  expect(other.err).toBe("forge search: busy; retry in 117s (retry in 17s)\n");
});

test("a refused token exits notConfigured; any other failure exits failed", async () => {
  reply = () => Response.json({ error: "unauthorized", message: "token expired" }, { status: 401 });
  const refused = await forge(["search", "retry"]);
  expect(refused.code).toBe(EXIT.notConfigured);
  expect(refused.err).toBe("forge search: token expired\n");

  reply = () => Response.json({ error: "internal", message: "search broke" }, { status: 500 });
  const broke = await forge(["search", "retry"]);
  expect(broke.code).toBe(EXIT.failed);
  expect(broke.err).toBe("forge search: search broke\n");
});

test("empty words and a bad flag are usage errors; help lists the command", async () => {
  const before = seen.length;
  const empty = await forge(["search"]);
  expect(empty.code).toBe(EXIT.usage);
  expect(empty.out).toContain("forge search <words…>");
  const blank = await forge(["search", "  "]);
  expect(blank.code).toBe(EXIT.usage);
  const kind = await forge(["search", "x", "--kind", "wiki"]);
  expect(kind.code).toBe(EXIT.usage);
  const limit = await forge(["search", "x", "--limit", "0"]);
  expect(limit.code).toBe(EXIT.usage);
  expect(seen.length).toBe(before);

  const help = await forge(["help"]);
  expect(help.out).toContain("forge search <words…>");
});

test("searchLines neutralises control characters and fits the width", () => {
  const lines = searchLines(
    {
      code: [{ repo: { owner: "a", name: "b" }, path: "x\x1b[2J.ts", line: 1, text: "evil\x1b]0;t\x07" }],
      issues: [],
      repos: [],
    },
    "all",
    40,
  );
  for (const line of lines) expect(line).not.toContain("\x1b");
  expect(lines[1]).toBe("a/b:x�[2J.ts:1  evil�]0;t�");
  const long = searchLines(ANSWER, "issues", 60);
  for (const line of long) expect(line.length).toBeLessThanOrEqual(59);
});

test("searchLines says when code search was cut short", () => {
  const lines = searchLines({ ...ANSWER, moreCode: true }, "code", 120);
  expect(lines.at(-1)).toContain("not searched in time");
});

test("searchLines heads a group the forge cut with \"more not shown\"", () => {
  const cut = { ...ANSWER, truncated: { repos: true, issues: false, code: true } };
  const lines = searchLines(cut, "all", 120);
  expect(lines).toContain("code (2, more not shown)");
  expect(lines).toContain("issues (2)");
  expect(lines).toContain("repos (1, more not shown)");
});
