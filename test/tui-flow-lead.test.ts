/** The Flow dialog says the time to land and who opened the last hour's pulls (#6496). */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { id } from "../src/kernel/id.ts";
import { flowLines } from "../src/tui/screens/flow.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const ago = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const text = (db: Parameters<typeof flowLines>[0]) => flowLines(db, NOW, [], undefined, []).join("\n");

async function seed() {
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "forge-tuiflow-")), port: 0 });
  const u = await createUser(app.db, { username: "alice", email: "a@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true, adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  const mk = async (name: string, visibility: "public" | "private") => {
    const x = await createRepo(app.db, app.reposRoot, { ownerId: u.value.id, name, visibility, description: name });
    if (!x.ok) throw new Error(x.error);
    return x;
  };
  const r = await mk("r", "public");
  const priv = await mk("priv", "private");
  let n = 0;
  const pull = (opened: number, merged: string | null, body = "", repo = r, author = u.value.id) => {
    const issueId = id();
    n++;
    app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', 'P', ?4, ?5, 'open', ?6)`).run(issueId, repo.value.id, n, body, author, ago(opened));
    app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at) VALUES (?1, ?2, ?3, '', '', ?4, ?5)`).run(issueId, repo.value.defaultBranch, `b/${n}`, repo.value.id, merged);
  };
  const user = async (name: string) => {
    const x = await createUser(app.db, { username: name, email: `${name}@forge.test`, password: "a-good-passphrase", origin: "seed", trusted: true });
    if (!x.ok) throw new Error(x.error);
    return x.value.id;
  };
  return { app, pull, priv, user };
}

describe("flow dialog lead time and openers", () => {
  test("a seeded database draws both lines", async () => {
    const s = await seed();
    s.pull(5, ago(1)); // 4 h
    s.pull(10, ago(2)); // 8 h
    s.pull(0.5, null);
    const t = text(s.app.db);
    expect(t).toContain("Time to land: median 6 h, slowest 8 h (24 h)");
    expect(t).toContain("alice: 1 pull, 0 for flow");
  });

  test("with no landings and no openers it says so in words", async () => {
    const s = await seed();
    const t = text(s.app.db);
    expect(t).toContain("nothing landed in the last 24 h");
    expect(t).toContain("Opened in the last hour: no pulls.");
    expect(t).not.toContain("0 h");
  });

  test("an agent reader does not see a private repository's author or lead time", async () => {
    const s = await seed();
    const bob = await s.user("bobsecret");
    s.pull(0.5, ago(0.25), "", s.priv, bob);
    const agent = flowLines(s.app.db, NOW, [], { queues: [] }, []).join("\n");
    expect(agent).toContain("Opened in the last hour: no pulls.");
    expect(agent).toContain("nothing landed in the last 24 h");
    expect(agent).not.toContain("bobsecret");
    const admin = text(s.app.db);
    expect(admin).toContain("bobsecret: 1 pull, 0 for flow");
    expect(admin).toContain("Time to land: median 15 min, slowest 15 min (24 h)");
  });

  test("six openers draw five lines", async () => {
    const s = await seed();
    for (const name of ["u1", "u2", "u3", "u4", "u5", "u6"]) s.pull(0.5, null, "", undefined, await s.user(name));
    const lines = text(s.app.db).split("\n").filter((l) => /^u\d: 1 pull, 0 for flow$/.test(l));
    expect(lines).toHaveLength(5);
    expect(text(s.app.db)).toContain("and 1 more");
  });
});
