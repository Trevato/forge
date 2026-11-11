/** `explore` with `kind: tree`: an app's fork chain in the words of its forks page, and only what the caller may read (#11377). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo, forkRepo } from "../src/actions/repos.ts";
import { setFollowMode } from "../src/actions/follow.ts";
import { followModeWords } from "../src/actions/follow_words.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let aliceToken: string;
let bobToken: string;
let cookie: string;

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const mk = async (username: string, first: boolean): Promise<User> =>
  must(await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first }));

async function tree(token: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "explore", arguments: args } }),
  });
  const body = (await res.json()) as any;
  const text = body.result.content[0].text as string;
  return body.result.isError === true ? { error: text.split(":")[0] } : JSON.parse(text);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-mcp-tree-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const alice = await mk("alice", true);
  const bob = await mk("bob", false);
  const carol = await mk("carol", false);
  proveAll(app);
  for (const u of [alice, bob, carol]) promote(app.db, u);
  aliceToken = createToken(app.db, alice.id, "t", "admin").token;
  bobToken = createToken(app.db, carol.id, "t", "admin").token;
  const root = must(await createRepo(app, alice, { name: "lib", visibility: "public" }));
  const mid = must(await forkRepo(app, alice, root, "lib-mid"));
  must(await forkRepo(app, alice, mid, "lib-leaf"));
  const secret = must(await forkRepo(app, bob, mid, "lib-secret"));
  app.db.run("UPDATE repo SET visibility = 'private' WHERE id = ?1", [secret.id]);
  await setFollowMode(app, alice, mid, "take-updates");
  const res = await fetch(`${servers.url}/signin`, { method: "POST", body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }), redirect: "manual" });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("explore kind: tree", () => {
  test("names the upstream chain and the direct forks", async () => {
    const t = await tree(aliceToken, { kind: "tree", app: "alice/lib-mid" });
    expect(t.app.repo).toBe("alice/lib-mid");
    expect(t.upstream.map((r: any) => r.repo)).toEqual(["alice/lib"]);
    expect(t.forks.map((r: any) => r.repo).sort()).toEqual(["alice/lib-leaf", "bob/lib-secret"]);
    expect(t.truncated).toBe(false);
    expect(t.upstream[0].follows).toBe("This repository follows nothing.");
  });

  test("says how each follows, in the page's words", async () => {
    const t = await tree(aliceToken, { kind: "tree", app: "alice/lib-mid" });
    expect(t.app.follows).toBe(followModeWords("take-updates", "alice/lib").line);
    expect(t.forks.find((r: any) => r.repo === "alice/lib-leaf").follows).toBe(followModeWords("tell-me", "alice/lib-mid").line);
    expect(t.app.standing).toBe("standing unknown");
  });

  test("parity: the forks page carries the same words", async () => {
    const t = await tree(aliceToken, { kind: "tree", app: "alice/lib-mid" });
    const page = await (await fetch(`${servers.url}/alice/lib-mid/forks`, { headers: { cookie } })).text();
    expect(page).toContain(t.app.follows);
    expect(page).toContain(t.forks.find((r: any) => r.repo === "alice/lib-leaf").standing);
    expect(page).toContain("alice/lib-leaf");
  });

  test("a private fork is omitted for a caller who cannot read it", async () => {
    const t = await tree(bobToken, { kind: "tree", app: "alice/lib-mid" });
    expect(t.forks.map((r: any) => r.repo)).toEqual(["alice/lib-leaf"]);
    expect(JSON.stringify(t)).not.toContain("lib-secret");
  });

  test("an app the caller cannot read is not found", async () => {
    expect((await tree(bobToken, { kind: "tree", app: "bob/lib-secret" })).error).toBe("not_found");
    expect((await tree(bobToken, { kind: "tree", app: "alice/nope" })).error).toBe("not_found");
  });
});
