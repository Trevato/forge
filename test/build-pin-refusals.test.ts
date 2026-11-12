/**
 * The OpenAPI document names every refusal of POST …/builds: each `error`
 * the handler answers is among the refusals the served document lists.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createOrigin, linkRepoToOrigin } from "../src/core/origins.ts";
import { getRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminOpenapi } from "./helpers/openapi-doc.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let oid: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-pin-refusals-"));
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
  for (const name of ["game", "lib"]) {
    const repo = await createRepo(app, alice, { name, visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    const c = await commitToBranch(app, alice, getRepo(app.db, "alice", name)!, {
      branch: "main",
      message: "one",
      files: [{ path: "one.txt", content: "one\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    if (name === "game") oid = c.value.commitOid;
  }
  const origin = createOrigin(app.db, app.config.dataDir, {
    userId: alice.id,
    kind: "forgejo",
    apiUrl: "http://127.0.0.1:9/api/v1",
    webUrl: "http://127.0.0.1:9",
    login: "alice",
    token: "t",
  });
  if (!origin.ok) throw new Error(origin.error);
  linkRepoToOrigin(app.db, getRepo(app.db, "alice", "lib")!.id, {
    originId: origin.value.id,
    fullName: "octo/lib",
    remoteId: "1",
    htmlUrl: "http://127.0.0.1:9/octo/lib",
  });
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("every error POST …/builds answers is a refusal the OpenAPI document lists", async () => {
  const doc = (await (await adminOpenapi(app, servers.url, "/api/v1/openapi.json")).json()) as any;
  const op = doc.paths["/api/v1/repos/{owner}/{name}/builds"].post;
  const refusals = String(op.responses.default.description).split("Refusals: ")[1] ?? "";
  const codes = [...refusals.matchAll(/`([a-z_]+)` \(/g)].map((m) => m[1]!);

  const token = createToken(app.db, alice.id, "t", "rw").token;
  const agent = await createAgent(app, alice, { username: "bot" });
  if (!agent.ok) throw new Error(String(agent.error));
  const agentToken = createToken(app.db, agent.value.user.id, "t", "rw").token;

  const pin = async (repo: string, as: string, body: Record<string, string>) => {
    const res = await fetch(`${servers.url}/api/v1/repos/alice/${repo}/builds`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${as}` },
      body: JSON.stringify(body),
    });
    return { status: res.status, error: ((await res.json()) as { error?: string }).error };
  };
  const first = await pin("game", token, { label: "v1", sha: oid });
  expect(first.status).toBe(201);

  const answers = [
    await pin("game", token, { label: "-bad", sha: oid }),
    await pin("game", token, { label: "v2", sha: oid, parent: "no spaces/allowed" }),
    await pin("game", token, { label: "v2", sha: "f".repeat(40) }),
    await pin("game", token, { label: "v1", sha: oid }),
    await pin("game", agentToken, { label: "v3", sha: oid }),
    await pin("lib", token, { label: "v1", sha: oid }),
  ];
  const wanted = ["invalid_label", "invalid_parent", "not_a_commit", "exists", "forbidden", "mirrored"];
  expect(answers.map((a) => a.error)).toEqual(wanted);
  for (const a of answers) expect(codes).toContain(a.error!);
});
