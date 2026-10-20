/** #3135: the settings page shows the check cell's memory the machine enforces, beside forge.json's. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let app: App;
let servers: Servers;
let cookie = "";
const saved = process.env["FORGE_CELL_MEMORY_MAX_MIB"];

const check = (limits: string) =>
  `{"check":{"run":"true","limits":${limits}}}`;

beforeAll(async () => {
  process.env["FORGE_CELL_MEMORY_MAX_MIB"] = "4096";
  dir = await mkdtemp(join(tmpdir(), "forge-cellmem-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  cookie = await adminCookie(app, { username: "olive", email: "olive@f.dev", password: "settings-password" });
}, 60_000);

afterAll(async () => {
  if (saved === undefined) delete process.env["FORGE_CELL_MEMORY_MAX_MIB"];
  else process.env["FORGE_CELL_MEMORY_MAX_MIB"] = saved;
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

async function repoWith(name: string, forgeJson: string): Promise<string> {
  const res = await fetch(`${servers.url}/new`, {
    method: "POST",
    headers: { cookie },
    body: new URLSearchParams({ name, visibility: "private", description: "x" }),
    redirect: "manual",
  });
  expect(res.status).toBeLessThan(400);
  const { getRepo } = await import("../src/core/repos.ts");
  const { getUserByName } = await import("../src/core/users.ts");
  const owner = getUserByName(app.db, "olive");
  const repo = getRepo(app.db, "olive", name);
  if (!owner || !repo) throw new Error("setup");
  const c = await commitToBranch(app, owner, repo, {
    message: "forge.json",
    files: [{ path: "forge.json", content: forgeJson }],
  });
  expect(c.ok).toBe(true);
  return await (await fetch(`${servers.url}/olive/${name}/settings`, { headers: { cookie } })).text();
}

test("a declared limit above the ceiling shows both numbers and the source", async () => {
  const body = await repoWith("over", check('{"memory":8192}'));
  expect(body).toContain("forge.json asks 8192 MiB");
  expect(body).toContain("4096 MiB");
  expect(body).toContain("FORGE_CELL_MEMORY_MAX_MIB");
});

test("a declared limit below the ceiling shows one number and no warning", async () => {
  const body = await repoWith("under", check('{"memory":1024}'));
  expect(body).toContain("1024 MiB");
  expect(body).not.toContain("forge.json asks");
  expect(body).not.toContain("FORGE_CELL_MEMORY_MAX_MIB");
});

test("with no ceiling set and nothing declared, the default is named", async () => {
  delete process.env["FORGE_CELL_MEMORY_MAX_MIB"];
  try {
    const body = await repoWith("plain", '{"check":{"run":"true"}}');
    expect(body).toContain("2048 MiB (the default; forge.json declares none)");
    expect(body).not.toContain("forge.json asks");
  } finally {
    process.env["FORGE_CELL_MEMORY_MAX_MIB"] = "4096";
  }
});

test("an unreadable check says so instead of vanishing", async () => {
  const body = await repoWith("broken", '{"check":{"run":"true","limits":{"memory":"<b>x</b>"}}}');
  expect(body).toContain("forge.json&#39;s check could not be read");
  expect(body).not.toContain("<b>x</b>");
});

test("with no variable set, a cut is blamed on the pod, not on the variable", async () => {
  delete process.env["FORGE_CELL_MEMORY_MAX_MIB"];
  const { usePodMemoryFile } = await import("../src/apps/check-memory.ts");
  const { writeFile } = await import("node:fs/promises");
  const pod = join(dir, "pod-memory.max");
  await writeFile(pod, String(8192 * 1048576));
  const restore = usePodMemoryFile(pod);
  try {
    const body = await repoWith("pod", check('{"memory":65536}'));
    expect(body).toContain("forge.json asks 65536 MiB");
    expect(body).toContain("6144 MiB");
    expect(body).toContain("75% of the pod&#39;s memory.max");
    expect(body).not.toContain("FORGE_CELL_MEMORY_MAX_MIB");
  } finally {
    restore();
    process.env["FORGE_CELL_MEMORY_MAX_MIB"] = "4096";
  }
});

test("the ceiling's origin is named from the environment, then the pod file", async () => {
  const { memoryCeilingSource } = await import("../src/apps/contain.ts");
  const { writeFile } = await import("node:fs/promises");
  const pod = join(dir, "memory.max");
  await writeFile(pod, String(8192 * 1048576));
  expect(memoryCeilingSource("2048", pod)).toBe("env");
  expect(memoryCeilingSource(undefined, pod)).toBe("pod");
  expect(memoryCeilingSource(undefined, join(dir, "absent"))).toBe("default");
});

test("each origin has its own words", async () => {
  const { ceilingWords } = await import("../src/apps/check-memory.ts");
  expect(ceilingWords("env")).toContain("FORGE_CELL_MEMORY_MAX_MIB");
  expect(ceilingWords("pod")).toBe("75% of the pod's memory.max");
  expect(ceilingWords("default")).not.toContain("FORGE_CELL_MEMORY_MAX_MIB");
});

test("what forge.json declares at a commit is read from git once", async () => {
  const { checkMemoryAt } = await import("../src/apps/check-memory.ts");
  const { repoDir } = await import("../src/git/repos.ts");
  const { listRefs } = await import("../src/git/read.ts");
  await repoWith("kept", check('{"memory":1024}'));
  const at = repoDir(app.reposRoot, "olive", "kept");
  const refs = await listRefs(at, "refs/heads/");
  const oid = refs.ok ? refs.value.find((r) => r.name === "refs/heads/main")?.oid : undefined;
  expect(oid).toBeDefined();
  const first = await checkMemoryAt(at, oid);
  expect(first).toContain("1024 MiB");
  await rm(at, { recursive: true, force: true });
  expect(await checkMemoryAt(at, oid)).toBe(first);
});
