/**
 * The note door on a mirrored app (#4818): a note is filed on the origin and
 * labelled there, a hide closes it there, and a hide reaches the bus like any
 * other close.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectOrigin } from "../src/actions/origins.ts";
import { moderateNote, sendNote, type Sender } from "../src/actions/app_notes.ts";
import { newApp } from "../src/actions/apps.ts";
import { createApp, type App } from "../src/app.ts";
import { getAppBySlug } from "../src/core/apps.ts";
import { listIssues, getIssue } from "../src/core/issues.ts";
import { markReaders, unadoptedAmong } from "../src/crew/direct.ts";
import { linkRepoToOrigin } from "../src/core/origins.ts";
import { getRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import { newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const visitor: Sender = { key: "v:abc", name: "visitor-abc123", person: false };
const input = { text: "make it blue", page: "", viewport: "390x844" };

describe("the note door on a mirrored app", () => {
  let dataDir: string;
  let app: App;
  let github: FakeForge;
  let alice: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-feedback-mirror-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.test",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(String(made.error));
    alice = made.value;
    const secret = createToken(app.db, alice.id, "upstream", "rw").token;
    github = serveFakeForge(newFakeState("github", "alice", secret));
    forgetProviders(dataDir);
    const connected = await connectOrigin(app, alice, { host: github.url, kind: "github", token: secret });
    if (!connected.ok) throw new Error(JSON.stringify(connected.error));
    const created = await newApp(app, alice, { name: "mirrored", description: "Words", visibility: "public" });
    if (!created.ok) throw new Error(String(created.error));
    const repo = getRepo(app.db, "alice", "mirrored")!;
    github.state.repos.push({ id: 7, fullName: "alice/mirrored", cloneUrl: `${github.url}/alice/mirrored.git`, defaultBranch: "main", push: true });
    linkRepoToOrigin(app.db, repo.id, {
      originId: connected.value.id,
      fullName: "alice/mirrored",
      remoteId: "7",
      htmlUrl: `${github.url}/alice/mirrored`,
    });
  });

  afterAll(async () => {
    github.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  test("a note is filed and labelled on the origin, and a hide closes it there and on the bus", async () => {
    const record = getAppBySlug(app.db, "mirrored")!;
    const repo = getRepo(app.db, "alice", "mirrored")!;
    const sent = await sendNote(app, record, repo, "production", undefined, visitor, input, "10.9.0.1");
    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    const remote = github.state.issues.get("alice/mirrored") ?? [];
    expect(remote).toHaveLength(1);
    expect(remote[0]!.state).toBe("open");
    expect(remote[0]!.labels).toContain("from-app");

    const seen: string[] = [];
    const off = app.bus.subscribe((e) => void seen.push(e.kind));
    const id = sent.value.id;
    const hidden = await moderateNote(app, record, repo, alice, id, "hide");
    off();
    expect(hidden.ok).toBe(true);
    expect(remote[0]!.state).toBe("closed");
    expect(getIssue(app.db, repo.id, remote[0]!.number)!.state).toBe("closed");
    expect(seen).toContain("issue.closed");
  });
});

describe("the note door on a native app", () => {
  let dataDir: string;
  let app: App;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-feedback-native-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  test("a hide appends issue.closed to the bus", async () => {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.test", adminIfFirst: true });
    if (!made.ok) throw new Error(String(made.error));
    const created = await newApp(app, made.value, { name: "plain", description: "Words", visibility: "public" });
    if (!created.ok) throw new Error(String(created.error));
    const record = getAppBySlug(app.db, "plain")!;
    const repo = getRepo(app.db, "bob", "plain")!;
    const sent = await sendNote(app, record, repo, "production", undefined, visitor, input, "10.9.0.2");
    if (!sent.ok) throw new Error(sent.error.message);
    const seen: string[] = [];
    const off = app.bus.subscribe((e) => void seen.push(e.kind));
    expect((await moderateNote(app, record, repo, made.value, sent.value.id, "hide")).ok).toBe(true);
    off();
    expect(seen).toContain("issue.closed");
  });

  test("a note is a reader's suggestion: unadopted, untrusted, and waiting", async () => {
    const bob = getUserByName(app.db, "bob")!;
    const created = await newApp(app, bob, { name: "quiet", description: "Words", visibility: "public" });
    if (!created.ok) throw new Error(String(created.error));
    const record = getAppBySlug(app.db, "quiet")!;
    const repo = getRepo(app.db, "bob", "quiet")!;
    const sent = await sendNote(app, record, repo, "production", undefined, visitor, input, "10.9.0.3");
    if (!sent.ok) throw new Error(sent.error.message);
    expect(sent.value.status.state).toBe("waiting");
    const issue = listIssues(app.db, repo.id).find((i) => i.title.startsWith("From the app"))!;
    expect(unadoptedAmong(app.db, repo, [issue]).has(issue.id)).toBe(true);
    const marked = markReaders(app.db, repo, [{ authorName: "bob", originAuthor: issue.originAuthor }]);
    expect(marked[0]!.untrusted).toBeDefined();
  });
});
