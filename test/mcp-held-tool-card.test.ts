/** The `held` tool, run against a real Later gate, answers with the card: the repo comes from the tool, the button from the review. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { linkIssue } from "../src/actions/dependencies.ts";
import { reviewGate } from "../src/actions/gate_review.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let token: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-held-tool-card-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  const alice = getUserByName(app.db, "alice")!;
  token = createToken(app.db, alice.id, "rw", "rw").token;
  const created = await createRepo(app, alice, { name: "engine", visibility: "public" });
  if (!created.ok) throw new Error(String(created.error));
  const repo = created.value;
  const open = (title: string, body = "") => {
    const o = openIssue(app, alice, repo, { title, body });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };
  open("P0 Trust: be trusted");
  const gate = open("Later gate: nothing behind this starts until the owner opens it");
  for (const t of ["Frobnicate the widget pipeline", "Frobnicate widget pipeline"]) linkIssue(app, alice, repo, open(t, "words"), gate);
});

afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("the tool's read carries card.repo, and the card has the Close N done button", async () => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "held", arguments: { app: "alice/engine" } } }),
  });
  const body: any = await res.json();
  const card = body.result.structuredContent?.card;
  const review = reviewGate(app, getRepo(app.db, "alice", "engine")!)!;
  expect(review.ticked.length).toBeGreaterThan(0);
  expect(card.title).toBe("Later");
  expect(card.rows.some((r: any) => r.link === `${servers.url}/alice/engine/issues/${review.ticked[0]}`)).toBe(true);
  expect(card.actions).toEqual([
    { label: `Close ${review.ticked.length} done`, tool: "held", args: { app: "alice/engine", apply: review.ticked, digest: review.digest } },
  ]);
});
