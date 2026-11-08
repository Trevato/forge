/** Flows (#9590): one line of every kind in and out is on the page, read from stored state, fast. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { getUserById } from "../src/core/users.ts";
import { setForkFollowMode } from "../src/core/fork_follow.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { refreshRadar, readRadar } from "../src/flows/radar.ts";
import { readPins } from "../src/flows/pins.ts";
import { readFlows } from "../src/flows/view.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { PREVIEW_ADMIN, PREVIEW_REPO } from "../src/spawn/preview-looks.ts";
import { expectWork, requestStatements } from "./helpers/work.ts";
import { seedPreview } from "../src/spawn/preview-seed.ts";

const KEY = "flows-lines-key";
let dir: string;
let app: App;
let servers: Servers;
const headers = () => {
  const said = `u1|trevato|admin|${Date.now() + 60_000}`;
  return { "x-forge-identity": said, "x-forge-signature": createHmac("sha256", KEY).update(said).digest("base64url") };
};
const url = () => `${servers.url}/${PREVIEW_ADMIN}/${PREVIEW_REPO}/flows`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-flows-lines-"));
  app = createApp({ dataDir: dir, port: 0, previewIdentityKey: KEY });
  const seeded = await seedPreview(app, { FORGE_APP_ENV: "preview" });
  if (!seeded.ok) throw new Error(seeded.error);
  servers = await serve(app);
  const repo = getRepo(app.db, PREVIEW_ADMIN, PREVIEW_REPO)!;
  const pkg = JSON.stringify({ dependencies: { leftish: "1.0.0" } });
  const c = await commitFiles(repoDir(app.reposRoot, repo.ownerName, repo.name), {
    branch: repo.defaultBranch, message: "pins", files: [{ path: "package.json", content: pkg }], author: { name: "T", email: "t@forge.test" },
  });
  if (!c.ok) throw new Error(JSON.stringify(c.error));
  await refreshRadar(app.db, repo.id, readPins(pkg), async () => ({ latest: "1.4.0", advisory: "high: prototype <script>pollution" }));
  app.db.query("INSERT INTO repo_source (id, repo_id, url, branch, by_id, created_at, checked_at) VALUES ('s1', ?1, 'https://src.example/x.git', 'main', 'u1', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z')").run(repo.id);
  app.db.exec("PRAGMA foreign_keys = OFF");
  app.db.query("INSERT INTO migrate_mirror (repo_id, origin_id, full_name, clone_url, pushed_at) VALUES (?1, 'o1', 'octo/mirrored-on-github', 'https://github.com/octo/m.git', '2026-11-03T00:00:00Z')").run(repo.id);
  const admin = getUserById(app.db, app.db.query<{ id: string }, [string]>("SELECT id FROM user WHERE username = ?").get(PREVIEW_ADMIN)!.id)!;
  const kid = await createRepo(app, admin, { name: "kid-fork", owner: PREVIEW_ADMIN, visibility: "public", description: "" });
  if (!kid.ok) throw new Error(JSON.stringify(kid.error));
  app.db.query("UPDATE repo SET fork_parent_id = ?1 WHERE id = ?2").run(repo.id, kid.value.id);
  setForkFollowMode(app.db, kid.value.id, "take-updates");
  app.db.query("INSERT INTO token (id, token_hash, user_id, name, scope, created_at) VALUES ('t1', 'h1', ?1, 'proposal:child-forge', 'rw', '2026-11-04T00:00:00Z')").run(admin.id);
  app.db.query("INSERT INTO proposal_token (token_id, repo_id, child, origin) VALUES ('t1', ?1, 'child-forge', 'https://child.example')").run(repo.id);
  app.db.exec("PRAGMA foreign_keys = ON");
}, 30_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("every line in and out", () => {
  test("the radar keeps an advisory with the newest release", () => {
    const repo = getRepo(app.db, PREVIEW_ADMIN, PREVIEW_REPO)!;
    const [dep] = readRadar(app.db, repo.id, readPins(JSON.stringify({ dependencies: { leftish: "1.0.0" } })));
    expect(dep).toMatchObject({ latest: "1.4.0", advisory: "high: prototype <script>pollution" });
  });

  test("the view names a forge that follows to a writer only, with when it last moved", () => {
    const repo = getRepo(app.db, PREVIEW_ADMIN, PREVIEW_REPO)!;
    const admin = getUserById(app.db, app.db.query<{ id: string }, [string]>("SELECT id FROM user WHERE username = ?").get(PREVIEW_ADMIN)!.id)!;
    const mine = readFlows(app.db, repo, admin).outbound.find((l) => l.kind === "forge")!;
    expect(mine).toMatchObject({ label: "child-forge (https://child.example/)", at: "2026-11-04T00:00:00Z" });
    expect(readFlows(app.db, repo, undefined).outbound.some((l) => l.kind === "forge")).toBe(false);
    const fork = readFlows(app.db, repo, undefined).outbound.find((l) => l.label.endsWith("/kid-fork"))!;
    expect(fork.state).toBe("fork, takes updates");
    expect(fork.at).not.toBeNull();
  });

  test("the page shows one of each kind, escaped, and costs a bounded number of reads", async () => {
    await (await fetch(url(), { headers: headers() })).text();
    const res = await fetch(url(), { headers: headers() });
    const text = await res.text();
    const cost = await requestStatements(app.db, url(), { headers: headers() });
    expect(res.status).toBe(200);
    for (const want of [
      "leftish", "newest 1.4.0", "advisory: high: prototype", "src.example/x.git", "octo/mirrored-on-github",
      `${PREVIEW_ADMIN}/kid-fork`, "fork, takes updates", "child-forge", "forge follows",
    ]) expect(text).toContain(want);
    expect(text).not.toContain("<script>pollution");
    // Stored state only: the page chrome plus a few reads (50 measured), no per-line query, no network.
    expectWork(cost, { max: 55 });
  });
});
