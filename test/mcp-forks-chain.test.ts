/** `forks` with `kind: chain`: one fork's lineage in the fork tree page's words (#11432). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo, forkRepo } from "../src/actions/repos.ts";
import { setFollowMode } from "../src/actions/follow.ts";
import { followModeWords } from "../src/actions/follow_words.ts";
import { SEVERED_LINE } from "../src/actions/detach_words.ts";
import { clearForkParent } from "../src/core/repos.ts";
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
let carolToken: string;

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const mk = async (username: string, first: boolean): Promise<User> =>
  must(await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first }));

async function chain(token: string, repo: string): Promise<any> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "forks", arguments: { repo, kind: "chain" } } }),
  });
  const body = (await res.json()) as any;
  return JSON.parse(body.result.content[0].text);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-mcp-chain-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const alice = await mk("alice", true);
  const bob = await mk("bob", false);
  const carol = await mk("carol", false);
  proveAll(app);
  for (const u of [alice, bob, carol]) promote(app.db, u);
  aliceToken = createToken(app.db, alice.id, "t", "admin").token;
  carolToken = createToken(app.db, carol.id, "t", "admin").token;
  const root = must(await createRepo(app, alice, { name: "lib", visibility: "public" }));
  const mid = must(await forkRepo(app, alice, root, "lib-mid"));
  const leaf = must(await forkRepo(app, alice, mid, "lib-leaf"));
  must(await forkRepo(app, alice, leaf, "lib-tip"));
  const secret = must(await forkRepo(app, bob, leaf, "lib-secret"));
  app.db.run("UPDATE repo SET visibility = 'private' WHERE id = ?1", [secret.id]);
  await setFollowMode(app, alice, leaf, "take-updates");
  // A fork cut loose the way detach does it.
  const cut = must(await forkRepo(app, bob, root, "lib-cut"));
  clearForkParent(app.db, cut.id);
  app.bus.append({ kind: "repo.detached", repoId: cut.id, actorId: bob.id, payload: { parentId: root.id } });
  must(await forkRepo(app, alice, cut, "lib-after"));
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("forks kind: chain", () => {
  test("names grandparent, parent, itself and children with the page's words and links", async () => {
    const t = await chain(aliceToken, "alice/lib-leaf");
    expect(t.chain.slice(0, 3).map((r: any) => `${r.role}:${r.repo}`)).toEqual(["grandparent:alice/lib", "parent:alice/lib-mid", "this:alice/lib-leaf"]);
    expect(t.chain.slice(3).map((r: any) => r.repo).sort()).toEqual(["alice/lib-tip", "bob/lib-secret"]);
    const me = t.chain.find((r: any) => r.role === "this");
    expect(me.follows).toBe(followModeWords("take-updates", "alice/lib-mid").line);
    expect(me.page).toBe("/alice/lib-leaf");
    expect(t.severed).toBe(false);
  });

  test("a private fork the caller cannot see is omitted, not named", async () => {
    const t = await chain(carolToken, "alice/lib-leaf");
    expect(JSON.stringify(t)).not.toContain("lib-secret");
    expect(t.chain.filter((r: any) => r.role === "child").map((r: any) => r.repo)).toEqual(["alice/lib-tip"]);
  });

  test("a severed link says severed and stops the chain", async () => {
    const t = await chain(aliceToken, "alice/lib-after");
    expect(t.chain.map((r: any) => r.role)).toEqual(["parent", "this"]);
    expect(t.chain[0].repo).toBe("bob/lib-cut");
    expect(t.chain[0].follows).toBe(SEVERED_LINE);
    expect(t.severed).toBe(true);
  });

  test("without kind, forks still lists forks", async () => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "forks", arguments: { repo: "alice/lib-leaf" } } }),
    });
    const body = JSON.parse(((await res.json()) as any).result.content[0].text);
    expect(body.chain).toBeUndefined();
    expect(Array.isArray(body.forks)).toBe(true);
  });
});
