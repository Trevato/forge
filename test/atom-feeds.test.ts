/** Both of a repository's feeds parse as Atom, round-trip awkward titles, and cache. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { writeWave } from "../src/story/wave.ts";
import { xml } from "../src/web/feeds.ts";
import { checkAtom } from "./helpers/atom.ts";

const TITLE = "Fish & <chips> 🍟 \"fresh\"";

describe("atom feeds", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-atom-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.dev", password: "a-good-passphrase", adminIfFirst: true });
    if (!u.ok) throw new Error(u.error);
    const made = await createRepo(app, u.value, { name: "r", visibility: "public", description: "d & <e> 🍟" });
    if (!made.ok) throw new Error(String(made.error));
    const wave = writeWave({
      version: "0.1.0",
      date: "2026-01-02",
      headline: TITLE,
      highlights: [1, 2, 3].map((n) => ({ title: `T${n} & 🍟`, why: "a < b" })),
      pulls: [],
    });
    if (!wave.ok) throw wave.error;
    await commitToBranch(app, u.value, made.value, {
      message: "seed",
      files: [{ path: "README.md", content: "hi\n" }, { path: "waves/0.1.0.md", content: wave.value }],
    });
    const issue = openIssue(app, u.value, made.value, { title: TITLE });
    if (!issue.ok) throw new Error(String(issue.error));
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  for (const feed of ["activity.atom", "waves.atom"]) {
    describe(feed, () => {
      const url = () => `${servers.url}/alice/r/${feed}`;

      test("parses as Atom and an awkward title reads back unchanged", async () => {
        const res = await fetch(url());
        expect(res.status).toBe(200);
        const { titles } = checkAtom(await res.text(), url());
        expect(titles.length).toBeGreaterThan(0);
        expect(titles.some((t) => t.includes(TITLE))).toBe(true);
      });

      test("is application/atom+xml with an ETag, and a repeat is a 304", async () => {
        const res = await fetch(url());
        expect(res.headers.get("content-type")).toStartWith("application/atom+xml");
        const etag = res.headers.get("etag");
        expect(etag).toBeTruthy();
        const again = await fetch(url(), { headers: { "if-none-match": etag! } });
        expect(again.status).toBe(304);
      });
    });
  }

  test("characters XML forbids are dropped, not emitted", () => {
    expect(xml("a\u0000b\u0008c\u001fd&e")).toBe("abcd&amp;e");
  });
});
