/** A wave's page lists the pulls it names: title, date, link; the unseen are left out (#5942). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { carriedPulls } from "../src/story/wave_pulls.ts";
import { pullRefs } from "../src/story/waves.ts";
import { writeWave } from "../src/story/wave.ts";
import { quietLogs } from "./helpers/globals.ts";
import { mergedPull } from "./helpers/wave-pulls.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let alice: User;
let bob: User;
let cookie = "";
let bobCookie = "";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const pull = (owner: User, repo: Repo, title: string) => mergedPull(app, owner, repo, title);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-wave-pulls-"));
  app = createApp({ dataDir: root, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, adminIfFirst: boolean) =>
    must(
      await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      }),
    );
  alice = await mk("alice", true);
  bob = await mk("bob", false);
  cookie = `forge_session=${createSession(app.db, alice.id).token}; forge_mode=dev`;
  bobCookie = `forge_session=${createSession(app.db, bob.id).token}; forge_mode=dev`;
  const pub = must(await createRepo(app, alice, { name: "pub", visibility: "public" }));
  const priv = must(await createRepo(app, alice, { name: "priv", visibility: "private" }));
  for (const [u, r] of [[alice, pub], [alice, priv]] as const)
    must(await commitToBranch(app, u, r, { message: "init", files: [{ path: "README.md", content: "hi\n" }] }));
  const a = await pull(alice, pub, "Add the <b>thing</b>");
  const b = await pull(alice, pub, "Fix the other");
  const c = await pull(alice, priv, "Secret work");
  const d = await pull(alice, pub, "Dropped idea");
  app.db
    .query("UPDATE pull SET merged_at = NULL WHERE issue_id IN (SELECT id FROM issue WHERE repo_id = ? AND number = ?)")
    .run(pub.id, d);
  app.db.query("UPDATE issue SET state = 'closed' WHERE repo_id = ? AND number = ?").run(pub.id, d);
  const base = "https://forge.example";
  const w = writeWave({
    version: "0.1.0",
    date: "2026-03-05",
    headline: "First",
    highlights: [1, 2, 3].map((n) => ({ title: `Thing ${n}`, why: "because" })),
    pulls: [
      { title: `#${a} x`, url: `${base}/alice/pub/pulls/${a}` },
      { title: `#${c} Secret work`, url: `${base}/alice/priv/pulls/${c}` },
      { title: `#${b} y`, url: `${base}/alice/pub/pulls/${b}` },
      { title: `#${d} z`, url: `${base}/alice/pub/pulls/${d}` },
      { title: "#999 gone", url: `${base}/alice/pub/pulls/999` },
    ],
  });
  if (!w.ok) throw w.error;
  must(await commitToBranch(app, alice, pub, { message: "wave", files: [{ path: "waves/0.1.0.md", content: w.value }] }));
  const e = writeWave({
    version: "0.2.0",
    date: "2026-03-06",
    headline: "Hidden",
    highlights: [1, 2, 3].map((n) => ({ title: `Thing ${n}`, why: "because" })),
    pulls: [{ title: `#${c} Secret work`, url: `${base}/alice/priv/pulls/${c}` }],
  });
  if (!e.ok) throw e.error;
  must(await commitToBranch(app, alice, pub, { message: "wave 2", files: [{ path: "waves/0.2.0.md", content: e.value }] }));
}, 60_000);
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("rows give #N title · merged date, link to the pull, and leave out the unseen", async () => {
  const res = await fetch(`${servers.url}/alice/pub/waves/0.1.0`, { headers: { cookie: bobCookie } });
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).toContain("Add the &lt;b&gt;thing&lt;/b&gt;");
  expect(body).not.toContain("<b>thing");
  expect(body).toContain("Fix the other");
  expect(body).toContain("merged 2026-03-04");
  expect(body).toMatch(/href="\/alice\/pub\/pulls\/\d+(?:\?from=[^"]*)?"[^>]*class="row"|class="row"[^>]*href="\/alice\/pub\/pulls\/\d+(?:\?from=[^"]*)?"/);
  expect(body).not.toContain("Secret work");
  expect(body).not.toContain("/alice/priv/pulls/");
  expect(body).not.toContain("#999");
});

test("a closed pull that never merged shows its state", async () => {
  const body = await (await fetch(`${servers.url}/alice/pub/waves/0.1.0`, { headers: { cookie: bobCookie } })).text();
  expect(body).toContain("Dropped idea");
  expect(body).not.toContain("not merged");
  expect(body).toMatch(/data-state="closed"/);
});

test("a wave whose pulls are all hidden says so", async () => {
  const body = await (await fetch(`${servers.url}/alice/pub/waves/0.2.0`, { headers: { cookie: bobCookie } })).text();
  expect(body).toContain("No pulls to show here.");
  expect(body).not.toContain("Secret work");
});

test("the owner of the private repository sees its pull", async () => {
  const body = await (await fetch(`${servers.url}/alice/pub/waves/0.1.0`, { headers: { cookie } })).text();
  expect(body).toContain("Secret work");
});

test("refs are read from the file and the phase is named", async () => {
  const refs = pullRefs({
    version: "0.1.0",
    date: "2026-03-05",
    headline: "h",
    highlights: [],
    pulls: [
      { title: "a", url: "https://x.example/alice/pub/pulls/1" },
      { title: "a again", url: "https://x.example/alice/pub/pulls/1/" },
      { title: "not a pull", url: "https://x.example/alice/pub/issues/1" },
      { title: "bad", url: "nonsense" },
    ],
  });
  expect(refs).toEqual([{ owner: "alice", name: "pub", number: 1 }]);
  const res = await fetch(`${servers.url}/alice/pub/waves/0.1.0`, { headers: { cookie } });
  await res.text();
  expect(res.headers.get("server-timing") ?? "").toMatch(/pulls;dur=\d+\.\d/);
});

describe("carriedPulls", () => {
  const numberOf = (repo: string, title: string): number =>
    app.db
      .query<{ number: number }, [string, string]>(
        "SELECT issue.number FROM issue JOIN repo ON repo.id = issue.repo_id WHERE repo.name = ? AND issue.title = ?",
      )
      .get(repo, title)!.number;
  const refs = () => [
    { owner: "alice", name: "pub", number: numberOf("pub", "Fix the other") },
    { owner: "alice", name: "priv", number: numberOf("priv", "Secret work") },
    { owner: "alice", name: "pub", number: 999 },
  ];
  const titles = (viewer: User | undefined) => carriedPulls(app.db, refs(), viewer).map((p) => p.title);

  test("a guest and a stranger get the public pull only; the private repository's owner gets both", () => {
    expect(titles(undefined)).toEqual(["Fix the other"]);
    expect(titles(bob)).toEqual(["Fix the other"]);
    expect(titles(alice)).toEqual(["Fix the other", "Secret work"]);
  });

  test("a reference to a pull that does not exist is left out, not an error", () => {
    const ghost = [{ owner: "alice", name: "pub", number: 999 }, { owner: "nobody", name: "nothing", number: 1 }];
    expect(carriedPulls(app.db, ghost, alice)).toEqual([]);
  });

  test("the titles are the live ones", () => {
    const n = numberOf("pub", "Dropped idea");
    const ref = [{ owner: "alice", name: "pub", number: n }];
    expect(carriedPulls(app.db, ref, undefined)[0]?.title).toBe("Dropped idea");
    app.db.query("UPDATE issue SET title = 'Renamed idea' WHERE title = 'Dropped idea'").run();
    expect(carriedPulls(app.db, ref, undefined)[0]?.title).toBe("Renamed idea");
  });
});

test("the page opens with one escaped sentence of what landed, and says when nothing did", async () => {
  const body = await (await fetch(`${servers.url}/alice/pub/waves/0.1.0`, { headers: { cookie: bobCookie } })).text();
  const start = body.indexOf("data-wave-sentence>") + "data-wave-sentence>".length;
  const text = body.slice(start, body.indexOf("</p>", start));
  expect(start).toBeGreaterThan("data-wave-sentence>".length - 1);
  expect(text).toContain("This wave landed ");
  expect(text).toContain("Add the &lt;b&gt;thing&lt;/b&gt;");
  expect(text).toContain("Fix the other");
  expect(text).not.toContain("<b>");
  expect(text).not.toContain("Dropped idea");
  expect(body.indexOf("data-wave-sentence")).toBeLessThan(body.indexOf("data-wave-size"));
  const none = await (await fetch(`${servers.url}/alice/pub/waves/0.2.0`, { headers: { cookie: bobCookie } })).text();
  expect(none).toContain("No pull in this wave has landed yet.");
});
