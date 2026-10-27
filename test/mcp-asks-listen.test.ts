import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getIssueById } from "../src/core/issues.ts";
import { muteRepo, mutedRepos } from "../src/core/interactions.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { mcpTool } from "./helpers/mcp.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
setDefaultTimeout(30_000);

let dataDir = "";
let app: App;
let servers: Servers;
let alice: User;
let bob: User;
let repo: Repo;
let aliceToken = "";

const act = (args: unknown) => mcpTool(servers.url, aliceToken, "asks_act", args);
const askRows = async () =>
  ((await mcpTool(servers.url, aliceToken, "asks", {})) as any).value.rows.length as number;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-listen-"));
  app = createApp({ dataDir, port: 0, disk: () => ({ freeBytes: 500e9, totalBytes: 1000e9 }) });
  servers = await serve(app);
  for (const name of ["alice", "bob"]) {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: name,
      email: `${name}@forge.local`,
      password: "a-long-listen-passphrase",
      adminIfFirst: name === "alice",
    });
    if (!made.ok) throw new Error(made.error);
    if (name === "alice") alice = made.value;
    else bob = made.value;
  }
  aliceToken = createToken(app.db, alice.id, "rw", "rw").token;
  await createAgent(app, alice, { username: "bot" });
  const made = await createRepo(app, alice, { name: "listen", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  await commitToBranch(app, alice, repo, {
    message: "seed",
    files: [{ path: "README.md", content: "# listen\n" }],
  });
  addToCrew(app, alice, repo, "bot");
  await commitToBranch(app, alice, repo, {
    branch: "bot/1",
    base: "main",
    message: "Work",
    files: [{ path: "F.md", content: "1\n" }],
  });
  const opened = await openPull(app, getUserByName(app.db, "bot")!, repo, {
    title: "Work",
    body: "",
    baseBranch: "main",
    headBranch: "bot/1",
  });
  if (!opened.ok) throw new Error(String(opened.error));
  expect(assignIssue(app, alice, repo, getIssueById(app.db, opened.value.id)!, alice).ok).toBe(true);
});

afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("listen brings a muted repository's asks back, for the caller only", async () => {
  const before = await askRows();
  expect(before).toBeGreaterThan(0);
  muteRepo(app.db, alice.id, repo.id);
  muteRepo(app.db, bob.id, repo.id);
  expect(await askRows()).toBe(0);

  // A call without dryRun only plans: the mute and the hidden asks stay.
  const planned = await act({ action: "listen", repo: "alice/listen" });
  expect(planned.value).toEqual({ wouldListen: ["alice/listen"] });
  expect(mutedRepos(app.db, alice.id).has(repo.id)).toBe(true);
  expect(await askRows()).toBe(0);

  // A read-only token cannot make the real write.
  const ro = createToken(app.db, alice.id, "ro", "ro").token;
  const refused = await mcpTool(servers.url, ro, "asks_act", { action: "listen", repo: "alice/listen", dryRun: false });
  expect(refused.error).toBeDefined();
  expect(mutedRepos(app.db, alice.id).has(repo.id)).toBe(true);

  const heard = await act({ action: "listen", repo: "alice/listen", dryRun: false });
  expect(heard.value).toEqual({ listening: ["alice/listen"] });
  expect(await askRows()).toBe(before);
  expect(mutedRepos(app.db, alice.id).has(repo.id)).toBe(false);
  expect(mutedRepos(app.db, bob.id).has(repo.id)).toBe(true);
});

test("listen refuses without a repo, and answers not_found for one not muted or unknown", async () => {
  expect((await act({ action: "listen" })).error).toContain("invalid");
  expect((await act({ action: "listen", repo: "alice/listen", dryRun: false })).error).toContain("not_found");
  expect((await act({ action: "listen", repo: "alice/nope" })).error).toContain("not_found");
});
