/** `flow` with kind "growth" (#11751): the queue page's growth numbers and pause words, for a repository the caller can read. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { growth } from "../src/core/growth.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dir: string;
let app: App;
let servers: Servers;
let adminTok: string;
let guestTok: string;
let id = 1;

const call = async (token: string, args: unknown) => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "flow", arguments: args } }),
  });
  const body: any = await res.json();
  const text: string = body.result.content[0].text;
  return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-mcp-growth-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first = false) => {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!u.ok) throw new Error(u.error);
    return u.value;
  };
  const alice = await mk("alice", true);
  const carol = await mk("carol");
  adminTok = createToken(app.db, alice.id, "rw", "rw").token;
  guestTok = createToken(app.db, carol.id, "rw", "rw").token;
  for (const [r, vis] of [["pub", "public"], ["priv", "private"]] as const)
    app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES (?1, ?2, ?1, ?3)", [r, alice.id, vis]);
  // Three days running (today and the two before) with issues opened and none closed.
  let n = 0;
  for (const back of [0, 1, 2])
    for (let k = 0; k < 2; k++) {
      n++;
      const at = new Date(Date.now() - back * 86_400_000).toISOString();
      for (const r of ["pub", "priv"])
        app.db.run(
          "INSERT INTO issue (id, repo_id, number, kind, title, author_id, state, created_at) VALUES (?1, ?2, ?3, 'issue', 't', ?4, 'open', ?5)",
          [`${r}${n}`, r, n, alice.id, at],
        );
    }
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("a list that grew three days running answers the page's own numbers and sentence", async () => {
  const r = await call(guestTok, { kind: "growth", repo: "alice/pub" });
  expect(r.value.growingRun).toBe(3);
  expect(r.value.open.issues).toBe(6);
  expect(r.value.daysQueued).toBeNull();
  const page = growth(app.db, { id: "pub", ownerId: "x" }, 14, new Date(), {});
  expect(r.value.suggest).not.toBeNull();
  expect(r.value.suggest).toBe(page.suggest);
  expect(r.value.sentences).toEqual(page.sentences);
  expect(r.value.perDay).toBe(page.perDay);
});

test("a private repository is refused to an outsider and answered to its owner", async () => {
  expect((await call(guestTok, { kind: "growth", repo: "alice/priv" })).error).toContain("no such");
  expect((await call(adminTok, { kind: "growth", repo: "alice/priv" })).value.growingRun).toBe(3);
});

test("growth needs a repository", async () => {
  expect((await call(adminTok, { kind: "growth" })).error).toBeDefined();
});
