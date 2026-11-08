import { afterEach, expect, test } from "bun:test";
import { EXIT, main } from "../src/cli/main.ts";
import { createOut } from "../src/cli/out.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
const env = { url: process.env["FORGE_URL"], token: process.env["FORGE_TOKEN"] };
afterEach(() => {
  server?.stop(true);
  for (const [k, v] of [["FORGE_URL", env.url], ["FORGE_TOKEN", env.token]] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
});

const seen: string[] = [];
function fake(items: unknown[], status = 200): void {
  seen.length = 0;
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push(url.pathname + url.search);
      if (status === 401)
        return Response.json({ error: "unauthorized", message: "sign in first" }, { status });
      return url.pathname === "/api/v1/repos/acme/app/runs"
        ? Response.json({ items, next_cursor: null })
        : Response.json({ error: "not_found", message: "no such resource here" }, { status: 404 });
    },
  });
  process.env["FORGE_URL"] = `http://127.0.0.1:${server.port}`;
  process.env["FORGE_TOKEN"] = "t";
}

async function run(argv: string[]) {
  const lines: string[] = [];
  const errs: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const werr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => (lines.push(String(s)), true)) as never;
  process.stderr.write = ((s: string) => (errs.push(String(s)), true)) as never;
  try {
    const code = await main(argv);
    return { code, text: lines.join(""), out: lines.join("").split("\n").filter(Boolean), err: errs.join("") };
  } finally {
    process.stdout.write = write;
    process.stderr.write = werr;
  }
}

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
// The branch and env say nothing the columns print: agent, number and title
// are the API's own fields (`nameRuns`), whatever the branch looks like.
const items = [
  { id: "a", kind: "agent", agent: "scout", number: 6038, title: "Login fix", branch: "feature/x", state: "running", summary: "", costUsd: 0.5, createdAt: ago(60_000), startedAt: ago(50_000), finishedAt: null },
  { id: "b", kind: "check", agent: null, number: 7696, title: "Tidy the header", env: "production", branch: "", state: "failed", summary: "3 tests failed", costUsd: 0, createdAt: ago(7_200_000), startedAt: null, finishedAt: null },
];

test("lists state, agent, number, title, age and cost, uncoloured when piped", async () => {
  fake(items);
  const r = await run(["runs", "--repo", "acme/app"]);
  expect(r.code).toBe(EXIT.ok);
  expect(r.out).toHaveLength(2);
  expect(r.out[0]).toMatch(/^running +scout +#6038 +Login fix +(?:now|\d+m) +\$0\.50$/);
  expect(r.out[1]).toMatch(/^failed +#7696 +Tidy the header +2h$/);
  expect(r.text).not.toContain("\x1b");
  expect(seen[0]).toContain("limit=10");
});

test("--json prints the API's answer unchanged", async () => {
  fake(items);
  const r = await run(["runs", "--repo", "acme/app", "--json"]);
  expect(JSON.parse(r.text)).toEqual({ items, next_cursor: null });
});

test("an unknown repository prints the API's words and fails", async () => {
  fake(items);
  const r = await run(["runs", "--repo", "acme/none"]);
  expect(r.code).toBe(EXIT.failed);
  expect(r.err).toContain("no such resource here");
});

test("not logged in exits not-configured", async () => {
  fake(items, 401);
  const r = await run(["runs", "--repo", "acme/app"]);
  expect(r.code).toBe(EXIT.notConfigured);
  expect(r.err).toContain("sign in first");
});

test("a bad --repo is a usage error", async () => {
  fake(items);
  expect((await run(["runs", "--repo", "nope"])).code).toBe(EXIT.usage);
});

test("an empty list says so", async () => {
  fake([]);
  const r = await run(["runs", "--repo", "acme/app"]);
  expect(r.code).toBe(EXIT.ok);
  expect(r.out).toEqual(["No runs yet."]);
});

test("an answer that is not a list of runs is one line, not a stack trace", async () => {
  for (const bad of [{ items: "oops" }, { items: [1] }, { items: [null] }, {}]) {
    seen.length = 0;
    server?.stop(true);
    server = Bun.serve({ port: 0, fetch: () => Response.json(bad) });
    process.env["FORGE_URL"] = `http://127.0.0.1:${server.port}`;
    process.env["FORGE_TOKEN"] = "t";
    const r = await run(["runs", "--repo", "acme/app"]);
    expect(r.code).toBe(EXIT.failed);
    expect(r.err).toBe("forge runs: unexpected answer\n");
  }
});

test("queued and cancelled rows age from createdAt and print without colour", async () => {
  fake([
    { id: "q", kind: "agent", agent: "mason", number: 12, title: "Add thing", branch: "mason/12-add-thing", state: "queued", summary: "", costUsd: 0, createdAt: ago(3 * 3_600_000), startedAt: null, finishedAt: null },
    { id: "c", kind: "deploy", agent: null, number: null, title: null, env: "pull-9", branch: "", state: "cancelled", summary: "stopped", costUsd: 0, createdAt: ago(86_400_000 * 2), startedAt: ago(86_400_000 * 2), finishedAt: ago(5 * 60_000) },
  ]);
  const r = await run(["runs", "--repo", "acme/app"]);
  expect(r.out[0]).toMatch(/^queued +mason +#12 +Add thing +3h$/);
  // A run about no pull or issue prints no number and no title, never a guess.
  expect(r.out[1]).toMatch(/^cancelled +5m$/);
});

test("on a terminal the state word wears its tone", async () => {
  fake(items);
  const saved = { isTTY: process.stdout.isTTY, noColor: process.env["NO_COLOR"], forge: process.env["FORGE_COLOR"] };
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  delete process.env["NO_COLOR"];
  delete process.env["FORGE_COLOR"];
  try {
    const o = createOut();
    const r = await run(["runs", "--repo", "acme/app"]);
    expect(r.out[0]!.startsWith(o.paint("running", o.c.attn))).toBe(true);
    expect(r.out[1]!.startsWith(o.paint("failed ", o.c.danger))).toBe(true);
    expect(o.c.attn).not.toEqual(o.c.danger);
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: saved.isTTY, configurable: true });
    if (saved.noColor !== undefined) process.env["NO_COLOR"] = saved.noColor;
    if (saved.forge !== undefined) process.env["FORGE_COLOR"] = saved.forge;
  }
});

test("without --repo the folder's origin names the repository", async () => {
  fake(items);
  const dir = await Bun.$`mktemp -d ${process.env["TMPDIR"] ?? "/tmp"}/runs-XXXXXX`.text();
  const here = process.cwd();
  try {
    await Bun.$`git init -q ${dir.trim()}`;
    await Bun.$`git -C ${dir.trim()} remote add origin ${process.env["FORGE_URL"]}/acme/app.git`;
    process.chdir(dir.trim());
    const r = await run(["runs"]);
    expect(r.code).toBe(EXIT.ok);
    expect(seen[0]).toContain("/repos/acme/app/runs");
  } finally {
    process.chdir(here);
  }
});

test("without --repo outside a clone is a usage error", async () => {
  fake(items);
  const dir = (await Bun.$`mktemp -d ${process.env["TMPDIR"] ?? "/tmp"}/runs-XXXXXX`.text()).trim();
  const here = process.cwd();
  try {
    process.chdir(dir);
    const r = await run(["runs"]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain("not a clone");
    expect(seen).toHaveLength(0);
  } finally {
    process.chdir(here);
  }
});
