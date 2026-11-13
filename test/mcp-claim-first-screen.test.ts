/** `claim_link` says, beside the link, what the recipient sees first: the one line the clients page reads. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { firstScreenLine } from "../src/core/next-steps.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let app: App;
let servers: Servers;
let token = "";
let id = 1;

const post = (path: string, body: unknown) =>
  fetch(`${servers.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
const claimLink = async (name: string) => {
  const res = await post("/mcp", {
    jsonrpc: "2.0", id: id++, method: "tools/call",
    params: { name: "claim_link", arguments: { name, reveal: true } },
  });
  const body = (await res.json()) as any;
  return JSON.parse(body.result.content[0].text) as { firstScreen?: string; claimUrl?: string };
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-claim-first-"));
  app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  const alice = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.test", password: "a-long-claim-passphrase", isAdmin: true });
  if (!alice.ok) throw new Error("user");
  token = createToken(app.db, alice.value.id, "rw", "rw").token;
  for (const n of ["bakery", "cafe"]) {
    const repo = await createRepo(app, alice.value, { name: n });
    if (!repo.ok) throw new Error("repo");
    const c = await commitFiles(repoDir(app.reposRoot, "alice", n), {
      branch: "main", message: n, files: [{ path: "README.md", content: `# ${n}\n` }],
      author: { name: "a", email: "a@x.invalid" },
    });
    if (!c.ok) throw new Error("commit");
  }
  servers = await serve(app);
  for (const [name, apps] of [["duo", ["alice/bakery", "alice/cafe"]], ["bare", []]] as const) {
    const made = await post("/api/v1/forges", { name, apps, dryRun: false });
    if (made.status !== 201) throw new Error(`spawn ${name} ${made.status} ${await made.text()}`);
  }
}, 60_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("two apps: the line names both, and is the clients page's own sentence", async () => {
  const got = await claimLink("duo");
  expect(got.claimUrl).toContain("#");
  expect(got.firstScreen).toBe(firstScreenLine(["alice/bakery", "alice/cafe"]));
  expect(got.firstScreen).toContain("alice/bakery, alice/cafe");
});

test("no apps: the line says the apps they pick", async () => {
  const got = await claimLink("bare");
  expect(got.firstScreen).toBe(firstScreenLine([]));
  expect(got.firstScreen).toContain("the apps you pick");
});
