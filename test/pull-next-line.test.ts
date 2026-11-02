/** The pull page says who acts next under its title, on both tabs, for an open pull only. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
const numbers: Record<string, number> = {};
const cells = process.env["FORGE_CELLS"];

const read = async (repo: string, tab: "" | "/files"): Promise<string> =>
  (
    await fetch(`${servers.url}/alice/${repo}/pulls/${numbers[repo]}${tab}`, {
      headers: { cookie: `forge_session=${createSession(app.db, alice.id).token}` },
    })
  ).text();

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-next-line-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  alice = made.value;
  for (const name of ["open", "merged"]) {
    const repo = await createRepo(app, alice, { name, visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    for (const [branch, file] of [[undefined, "forge.json"], ["topic", "t.txt"]] as const) {
      const done = await commitToBranch(app, alice, repo.value, {
        ...(branch === undefined ? {} : { branch }),
        message: "change",
        files: [{ path: file, content: file === "forge.json" ? "{}" : "x" }],
      });
      if (!done.ok) throw new Error(JSON.stringify(done.error));
    }
    const pull = await openPull(app, alice, repo.value, {
      title: name,
      body: "",
      baseBranch: "main",
      headBranch: "topic",
    });
    if (!pull.ok) throw new Error(JSON.stringify(pull.error));
    numbers[name] = pull.value.number;
    if (name === "merged") {
      const done = await mergePull(app, alice, repo.value, pull.value, "merge");
      if (!done.ok) throw new Error(JSON.stringify(done.error));
    }
  }
});

afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("an open pull with no review names the reviewer on the change tab and on Files", async () => {
  for (const tab of ["", "/files"] as const) {
    const body = await read("open", tab);
    expect(body).toContain("Next: reviewer, no review yet.");
    expect(body).toContain('class="next-actor');
  }
});

test("a merged pull draws no next line", async () => {
  for (const tab of ["", "/files"] as const)
    expect(await read("merged", tab)).not.toContain("next-actor");
});
