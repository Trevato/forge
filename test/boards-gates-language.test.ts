/** /boards' last merge gates speak the home page's language (#9954): a heading and rows, no card. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { keepGateResult, type GateResult } from "../src/checks/gate_result.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";

let dir: string;
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let token: string;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const gate = (over: Partial<GateResult>): GateResult => ({
  repoId: "r1", runId: "gate-abc", tipOid: "abc", pulls: [1], state: "green", passed: 10, failed: 0, failing: [],
  startedAt: ago(12), finishedAt: ago(10), ...over,
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-gates-lang-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const r = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!r.ok) throw new Error(r.error);
  token = createToken(app.db, r.value.id, "t", "admin").token;
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('r1', ?1, 'svc', 'public')", [r.value.id]);
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('r2', ?1, 'hidden', 'private')", [r.value.id]);
  keepGateResult(app.db, "g1", gate({ pulls: [12] }));
  keepGateResult(
    app.db, "g2",
    gate({ pulls: [15], state: "red", failed: 1, failing: [{ name: "it works", errors: ["boom", "second"] }], finishedAt: ago(5) }),
  );
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const section = async (as: string | null = token): Promise<string> => {
  const html = await (await fetch(`${servers.url}/boards`, { headers: as === null ? {} : { authorization: `Bearer ${as}` } })).text();
  const at = html.indexOf('id="gates"');
  expect(at).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<section", at), html.indexOf("</section>", at));
};

test("the last gates are a section under an h2, rows in a .list, no card", async () => {
  const s = await section();
  expect(s).toMatch(/^<section[^>]*id="gates"/);
  expect(s).not.toContain('class="card');
  expect(s).toContain("<h2>Last gates</h2>");
  expect(s).toContain('<ul class="list">');
  expect(s).toContain('href="/alice/svc/pulls/12"');
});

test("a red row names the first failing test and its first error only", async () => {
  const s = await section();
  expect(s).toContain("it works — boom");
  expect(s).not.toContain("second");
});

test("a private repository's gate is listed for the owner (the public one too)", async () => {
  keepGateResult(app.db, "g4", gate({ repoId: "r2", pulls: [77], finishedAt: ago(1) }));
  expect(await section()).toContain('href="/alice/hidden/pulls/77"');
});

test("/boards shows gates to the forge's owner alone: a plain account or a guest never gets the private gate", async () => {
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bobby", email: "b@forge.local", password: "a-good-passphrase" });
  if (!b.ok) throw new Error(b.error);
  const other = createToken(app.db, b.value.id, "t", "ro").token;
  for (const who of [other, null]) {
    const r = await fetch(`${servers.url}/boards`, { redirect: "manual", headers: who === null ? {} : { authorization: `Bearer ${who}` } });
    const body = await r.text();
    expect(body).not.toContain("pulls/77");
    expect(body).not.toContain("alice/hidden");
    expect(body).not.toContain('id="gates"');
  }
});
