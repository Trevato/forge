import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("changelog page", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;

  const commit = async (repo: Awaited<ReturnType<typeof createRepo>> extends infer R ? (R extends { ok: true; value: infer V } ? V : never) : never, message: string, n: number) =>
    must(await commitToBranch(app, alice, repo, { message, files: [{ path: `f${n}.txt`, content: `${n}\n` }] }));

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-changelog-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    alice = must(
      await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: "alice",
        email: "alice@f.dev",
        password: "a-good-passphrase",
        adminIfFirst: true,
      }),
    );
    const repo = must(await createRepo(app, alice, { name: "forge", visibility: "public" }));
    app.config.forgeRepo = "alice/forge";
    await commit(repo, "Release 0.1.0: First <b>thing</b> (#1)", 1);
    await commit(repo, "unrelated work", 2);
    await commit(repo, "Release 0.2.0: Second (#2);Third (#3)", 3);
    await commit(repo, "Release 0.3.0: Fourth (#4)", 4);
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("lists releases newest first with anchors, dates and escaped pull links, to anyone", async () => {
    const res = await fetch(`${servers.url}/changelog`);
    expect(res.status).toBe(200);
    expect(res.headers.get("server-timing")).toContain("releases");
    const body = await res.text();
    const at = (s: string) => body.indexOf(s);
    expect(at('id="0.3.0"')).toBeGreaterThan(-1);
    expect(at('id="0.3.0"')).toBeLessThan(at('id="0.2.0"'));
    expect(at('id="0.2.0"')).toBeLessThan(at('id="0.1.0"'));
    expect(body).toContain('href="/alice/forge/pulls/2"');
    expect(body).toContain('href="/alice/forge/pulls/3"');
    expect(body).toContain("<time");
    expect(body).toContain("First &lt;b&gt;thing&lt;/b&gt;");
    expect(body).not.toContain("<b>thing</b>");
    expect(body).not.toContain("unrelated work");
  });

  test("the footer links to it", async () => {
    const body = await (await fetch(`${servers.url}/changelog`)).text();
    expect(body).toContain('href="/changelog"');
  });

  test("with no forge repository it answers 200 and says there are no releases", async () => {
    const kept = app.config.forgeRepo;
    delete app.config.forgeRepo;
    const res = await fetch(`${servers.url}/changelog`);
    if (kept !== undefined) app.config.forgeRepo = kept;
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("No releases yet");
  });

  test("a new release shows after the head moves", async () => {
    const repo = getRepo(app.db, "alice", "forge")!;
    await commit(repo, "Release 0.4.0: Fifth (#5)", 5);
    const body = await (await fetch(`${servers.url}/changelog`)).text();
    expect(body.indexOf('id="0.4.0"')).toBeGreaterThan(-1);
  });

  test("a private forge repository shows the empty state, with no version or pull link", async () => {
    app.db.run("UPDATE repo SET visibility = 'private' WHERE name = 'forge'");
    try {
      const body = await (await fetch(`${servers.url}/changelog`)).text();
      expect(body).toContain("No releases yet");
      expect(body).not.toContain('id="0.');
      expect(body).not.toContain("/alice/forge/pulls/");
    } finally {
      app.db.run("UPDATE repo SET visibility = 'public' WHERE name = 'forge'");
    }
  });

  test("only well-formed release subjects count, and the page shows exactly 30", async () => {
    const repo = getRepo(app.db, "alice", "forge")!;
    await commit(repo, "Release 9: not a version (#90)", 90);
    for (let n = 0; n < 31; n++) await commit(repo, `Release 1.0.${n}: Thing ${n} (#${100 + n})`, 100 + n);
    const body = await (await fetch(`${servers.url}/changelog`)).text();
    expect(body.match(/<[a-z]+ [^>]*id="\d+\.\d+\.\d+"/g)?.length).toBe(30);
    expect(body).toContain('id="1.0.30"');
    expect(body).not.toContain('id="1.0.0"');
    expect(body).not.toContain("not a version");
  }, 60_000);
});
