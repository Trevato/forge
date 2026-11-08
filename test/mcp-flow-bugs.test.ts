/** `flow` with kind "bugs" (#8973): open bugs on their clocks, gated as the terminal's bugs screen. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dir: string;
let app: App;
let servers: Servers;
let adminTok: string;
let guestTok: string;
let id = 1;
let n = 0;

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

function bug(repo: string, hoursOld: number, high: boolean) {
  n++;
  const iid = `i${n}`;
  app.db.run(
    "INSERT INTO issue (id, repo_id, number, kind, title, author_id, state, created_at) VALUES (?1, ?2, ?3, 'issue', 't', (SELECT id FROM user LIMIT 1), 'open', ?4)",
    [iid, repo, n, hoursAgo(hoursOld)],
  );
  app.db.run("INSERT INTO issue_label (issue_id, label_id) VALUES (?1, ?2)", [iid, `${repo}-bug`]);
  if (high) app.db.run("INSERT INTO issue_label (issue_id, label_id) VALUES (?1, ?2)", [iid, `${repo}-high`]);
  return n;
}

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
  dir = await mkdtemp(join(tmpdir(), "forge-mcp-flow-bugs-"));
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
  for (const [r, vis] of [["pub", "public"], ["priv", "private"]] as const) {
    app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES (?1, ?2, ?1, ?3)", [r, alice.id, vis]);
    app.db.run("INSERT INTO label (id, repo_id, name) VALUES (?1, ?2, 'bug')", [`${r}-bug`, r]);
    app.db.run("INSERT INTO label (id, repo_id, name) VALUES (?1, ?2, 'high')", [`${r}-high`, r]);
  }
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("an overdue high bug is named first; a private repository's bug is hidden from a guest", async () => {
  const late = bug("pub", 5, true);
  bug("pub", 1, false);
  const secret = bug("priv", 10, true);
  const admin = await call(adminTok, { kind: "bugs" });
  expect(admin.value.open).toBe(3);
  expect(admin.value.overdue).toBe(2);
  expect(admin.value.bugs[0]).toMatchObject({ repo: "alice/priv", number: secret, priority: "high" });
  expect(admin.value.bugs.map((b: any) => b.repo)).toContain("alice/priv");

  const guest = await call(guestTok, { kind: "bugs" });
  expect(guest.value.open).toBe(2);
  expect(guest.value.overdue).toBe(1);
  expect(guest.value.bugs[0]).toMatchObject({ repo: "alice/pub", number: late, priority: "high" });
  expect(JSON.stringify(guest.value)).not.toContain("priv");
});

test("an unknown kind is refused", async () => {
  expect((await call(adminTok, { kind: "nope" })).error).toContain("kind");
});
