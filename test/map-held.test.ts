/** GET …/map names what holds each ready issue (#6441): `held`, and `startable` for the rest. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { openPull } from "../src/actions/pulls.ts";
import { holdFile } from "../src/crew/file_holds.ts";
import { getUserByName } from "../src/core/users.ts";
import { createIssue } from "../src/core/issues.ts";
import { HOT_PULLS, rememberPullFiles } from "../src/crew/hot_files.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers, repoId = "", bearer = "";
const nums: Record<string, number> = {};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-mapheld-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const made = await createRepo(app, admin.value, { name: "notes", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  repoId = made.value.id;
  rememberPullFiles(
    repoId,
    Array.from({ length: HOT_PULLS }, (_, i) => ({ number: i + 1, files: ["src/hot.ts", `src/own${i}.ts`] })),
  );
  const add = (key: string, title: string, body = "", sealed = false) => {
    const r = createIssue(app.db, { repoId, authorId: admin.value.id, title, body, sealed });
    if (!r.ok) throw new Error(r.error);
    nums[key] = r.value.number;
  };
  add("hot", "Add a flag to src/hot.ts");
  add("free", "Tidy src/cold.ts");
  add("secret", "Leak in src/hot.ts", "", true);
  // A sealed pull touching the same file: only a viewer who may see it counts it.
  rememberPullFiles(repoId, [
    ...Array.from({ length: HOT_PULLS }, (_, i) => ({ number: 100 + i, files: ["src/hot.ts"] })),
    { number: nums.secret!, files: ["src/hot.ts"] },
  ]);
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
});

afterAll(async () => {
  rememberPullFiles(repoId, []);
  servers.stop?.();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a ready issue holding a hot file says so, and startable lists only the free one", async () => {
  const res = await fetch(`${servers.url}/api/v1/repos/alice/notes/map`);
  const body = (await res.json()) as {
    ready: { number: number; held: { by: string; detail: string } | null }[];
    startable: number[];
  };
  const of = (n: number) => body.ready.find((r) => r.number === n)!;
  expect(of(nums.hot!).held?.by).toBe("hot_file");
  expect(of(nums.hot!).held?.detail).toContain("src/hot.ts");
  expect(of(nums.hot!).held?.detail).toContain(`${HOT_PULLS} open pulls`);
  expect(of(nums.free!).held).toBeNull();
  expect(body.startable).toEqual([nums.free!]);
});

test("an anonymous reader is told nothing of a sealed issue", async () => {
  const res = await fetch(`${servers.url}/api/v1/repos/alice/notes/map`);
  const text = await res.text();
  expect(text).not.toContain("Leak in");
  expect(JSON.parse(text).ready.some((r: { number: number }) => r.number === nums.secret)).toBe(false);
  expect(JSON.parse(text).startable).not.toContain(nums.secret);
});

type Ready = { ready: { number: number; held: { by: string; detail: string } | null }[] };

test("a sealed pull is not counted for a guest, and is for a viewer who may see it", async () => {
  const guest = (await (await fetch(`${servers.url}/api/v1/repos/alice/notes/map`)).json()) as Ready;
  const admin = (await (
    await fetch(`${servers.url}/api/v1/repos/alice/notes/map`, { headers: { authorization: `Bearer ${bearer}` } })
  ).json()) as Ready;
  const detail = (m: Ready) => m.ready.find((r) => r.number === nums.hot!)?.held?.detail;
  expect(detail(guest)).toBe(`src/hot.ts is in ${HOT_PULLS} open pulls`);
  expect(detail(admin)).toBe(`src/hot.ts is in ${HOT_PULLS + 1} open pulls`);
});

test("the MCP map tool carries held and startable too", async () => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "map", arguments: { app: "alice/notes" } },
    }),
  });
  const body: any = await res.json();
  const map = JSON.parse(body.result.content[0].text) as Ready & { startable: number[] };
  expect(map.ready.find((r) => r.number === nums.hot!)?.held?.by).toBe("hot_file");
  expect(map.startable).toEqual([nums.free!]);
});

test("an open pull a guest cannot see holds nothing for the guest; an admin's map says open_pull", async () => {
  const alice = getUserByName(app.db, "alice")!;
  const made = await createRepo(app, alice, { name: "pulls", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;
  const mk = (title: string) => {
    const r = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title, body: "" });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const closed = mk("Proposed by a sealed pull");
  const pinned = mk("Edit src/pinned.ts");
  const seeded = await commitToBranch(app, alice, repo, {
    message: "Start",
    files: [{ path: "README.md", content: "# pulls\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  const branch = await commitToBranch(app, alice, repo, {
    branch: "feature/sealed",
    base: "main",
    message: "Fix",
    files: [{ path: "fix.ts", content: "export const n = 1;\n" }],
  });
  if (!branch.ok) throw new Error(JSON.stringify(branch.error));
  const pull = await openPull(app, alice, repo, {
    title: "Fix",
    body: `Closes #${closed.number}`,
    baseBranch: "main",
    headBranch: "feature/sealed",
  });
  if (!pull.ok) throw new Error(String(pull.error));
  // The pull is an issue row: seal it the way a security fix is.
  app.db.query("UPDATE issue SET sealed = 1 WHERE repo_id = ?1 AND number = ?2").run(repo.id, pull.value.number);
  expect(holdFile(app.db, repo.id, "src/pinned.ts", alice.id).ok).toBe(true);

  const read = async (headers: Record<string, string>) =>
    (await (await fetch(`${servers.url}/api/v1/repos/alice/pulls/map`, { headers })).json()) as Ready;
  const guest = await read({});
  const admin = await read({ authorization: `Bearer ${bearer}` });
  const held = (m: Ready, n: number) => m.ready.find((r) => r.number === n)?.held;
  expect(held(guest, closed.number)).toBeNull();
  expect(held(admin, closed.number)?.by).toBe("open_pull");
  expect(held(guest, pinned.number)?.detail).toBe("src/pinned.ts is held by an admin");
  expect(held(admin, pinned.number)?.by).toBe("hot_file");
});
