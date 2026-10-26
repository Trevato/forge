/** `/:owner/:name/following` names session, repo, chain, parent, upstream and render in Server-Timing (#3461). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { childDirOf, spawnForge } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let root: App;
let child: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-chain-mode-"));
  root = createApp({ dataDir: dir, url: "https://root.test", port: 0, forgeRepo: "alice/forge-code" });
  const alice = await createUser(root.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.test", isAdmin: true });
  if (!alice.ok) throw new Error("user");
  const made = await createRepo(root, alice.value, { name: "forge-code", visibility: "public" });
  if (!made.ok) throw new Error("repo");
  const c = await commitFiles(repoDir(root.reposRoot, "alice", "forge-code"), {
    branch: "main",
    message: "forge v1",
    files: [{ path: "README.md", content: "# forge\n" }],
    author: { name: "a", email: "a@x.invalid" },
  });
  if (!c.ok) throw new Error("commit");
  const a = await spawnForge(
    root,
    alice.value,
    { name: "kid", org: "kid", apps: [], carryBriefs: false, carrySubscriptions: false },
    { catalog: [], briefs: [], subscriptions: [] },
    {
      placement: hostedPlacement({ host: "root.test" }),
      request: new Request("https://root.test/x", { method: "POST", headers: { origin: "https://root.test" } }),
      url: new URL("https://root.test/x"),
    },
  );
  if (!a.ok) throw new Error(JSON.stringify(a.error));
  child = createApp({ dataDir: childDirOf(root, a.value.bodyId), port: 0 });
  servers = await serve(child);
  const owner = getUserByName(child.db, "alice")!;
  cookie = `forge_session=${createSession(child.db, owner.id).token}`;
}, 60_000);

afterAll(async () => {
  servers.stop();
  child.close();
  root.close();
  await rm(dir, { recursive: true, force: true });
});

test("GET /:owner/:name/following names its phases", async () => {
  const res = await fetch(`${servers.url}/kid/forge/following`, { headers: { cookie } });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("Following");
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  for (const name of ["app", "session", "repo", "chain", "parent", "upstream", "render"])
    expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
});
