/**
 * Who gets the issue's link with a note (#10560): anyone who can read the
 * repository, with the number shown to everyone.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { notesFor, sendNote, type Sender } from "../src/actions/app_notes.ts";
import { createApp, type App } from "../src/app.ts";
import { getAppBySlug } from "../src/core/apps.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const FORGE = "https://forge.test";
const input = { text: "make it blue", page: "", viewport: "390x844" };

describe("the link a note's sender gets", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let seq = 0;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-notes-link-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.test", adminIfFirst: true });
    if (!made.ok) throw new Error(String(made.error));
    alice = made.value;
    for (const name of ["sandbox-game", "open-door"]) {
      const a = await newApp(app, alice, { name, description: "Words", visibility: "private" });
      if (!a.ok) throw new Error(String(a.error));
    }
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  const person: Sender = { key: "", name: "@alice", person: true };
  const visitor = (): Sender => ({ key: `v:link${++seq}`, name: `visitor-${seq}`, person: false });

  test("the owner of a private app gets the number, the issue's link and the repository's", async () => {
    const record = getAppBySlug(app.db, "sandbox-game")!;
    const repo = getRepo(app.db, "alice", "sandbox-game")!;
    const sender = { ...person, key: `u:${alice.id}` };
    const sent = await sendNote(app, record, repo, "production", FORGE, sender, input, "10.1.0.1", alice);
    if (!sent.ok) throw new Error(sent.error.message);
    expect(sent.value.number).toBeGreaterThan(0);
    expect(sent.value.url).toBe(`${FORGE}/alice/sandbox-game/issues/${sent.value.number}`);
    expect(sent.value.repoUrl).toBe(`${FORGE}/alice/sandbox-game`);
    const listed = notesFor(app, record, repo, FORGE, sender, false, alice);
    expect(listed[0]?.url).toBe(sent.value.url);
    expect(listed[0]?.repoUrl).toBe(sent.value.repoUrl);
  });

  test("a signed-out visitor of a public app on a private repo gets the number and no link", async () => {
    const record = getAppBySlug(app.db, "open-door")!;
    const repo = getRepo(app.db, "alice", "open-door")!;
    app.db.query("UPDATE app SET access = 'public' WHERE id = ?1").run(record.id);
    const open = getAppBySlug(app.db, "open-door")!;
    expect(open.access).toBe("public");
    expect(repo.visibility).toBe("private");
    const who = visitor();
    const sent = await sendNote(app, open, repo, "production", FORGE, who, input, "10.1.0.2");
    if (!sent.ok) throw new Error(sent.error.message);
    expect(sent.value.number).toBeGreaterThan(0);
    expect(sent.value.url).toBeUndefined();
    expect(sent.value.repoUrl).toBeUndefined();
    const listed = notesFor(app, open, repo, FORGE, who);
    expect(listed[0]?.number).toBe(sent.value.number);
    expect(listed[0]?.url).toBeUndefined();
  });
});
