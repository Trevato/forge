/**
 * A repository's activity as an Atom feed: well-formed, made of sentences
 * and links that are already public on the repository's pages, never a raw
 * payload; a private repository's feed is its readers' alone.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { editIssue, openIssue } from "../src/actions/issues.ts";
import {
  commitToBranch,
  createRepo,
  createWebhook,
  forkRepo,
  updateRepoSettings,
} from "../src/actions/repos.ts";
import { getIssue } from "../src/core/issues.ts";
import { getRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("a repository's feed", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let bob: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-feeds-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    promote(app.db, bob);
    const made = await createRepo(app, alice, {
      name: "game",
      visibility: "public",
      description: "a <small> game & its levels",
    });
    if (!made.ok) throw new Error(String(made.error));
    await commitToBranch(app, alice, made.value, {
      message: "seed",
      files: [{ path: "README.md", content: "# game\n" }],
    });
    const issue = openIssue(app, bob, made.value, {
      title: 'the "boss" <level> is too hard & long',
    });
    if (!issue.ok) throw new Error(String(issue.error));
    const forked = await forkRepo(app, bob, made.value);
    if (!forked.ok) throw new Error(String(forked.error));
    const hook = createWebhook(app, alice, made.value, {
      url: "https://hooks.example.test/T0/s3cr3t",
    });
    if (!hook.ok) throw new Error(String(hook.error));
    const hidden = await createRepo(app, alice, {
      name: "secret",
      visibility: "private",
    });
    if (!hidden.ok) throw new Error(String(hidden.error));
    await commitToBranch(app, alice, hidden.value, {
      message: "seed",
      files: [{ path: "README.md", content: "# secret\n" }],
    });
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("it is Atom: the required elements, escaped, newest first", async () => {
    const res = await fetch(`${base}/alice/game/activity.atom`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/atom+xml");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const body = await res.text();
    expect(body).toStartWith('<?xml version="1.0" encoding="utf-8"?>');
    expect(body).toContain('<feed xmlns="http://www.w3.org/2005/Atom">');
    expect(body).toContain(`<id>${base}/alice/game/activity.atom</id>`);
    expect(body).toContain("<title>alice/game</title>");
    expect(body).toContain(
      "<subtitle>a &lt;small&gt; game &amp; its levels</subtitle>",
    );
    expect(body).toMatch(/<updated>\d{4}-\d\d-\d\dT[\d:.]+Z<\/updated>/);
    expect(body).toContain(
      `<link rel="self" type="application/atom+xml" href="${base}/alice/game/activity.atom"/>`,
    );
    // An issue's title is user text: escaped, never markup.
    expect(body).toContain(
      "bob opened an issue: #1 the &quot;boss&quot; &lt;level&gt; is too hard &amp; long",
    );
    expect(body).not.toContain("<level>");
    expect(body).toContain(`href="${base}/alice/game/issues/1"`);
    expect(body).toContain("alice pushed: main");
    expect(body).toContain(`href="${base}/alice/game/commits"`);
    const order = [...body.matchAll(/<title>([^<]*)<\/title>/g)].map(
      (m) => m[1]!,
    );
    expect(
      order.findIndex((t) => t.startsWith("bob opened an issue")),
    ).toBeLessThan(order.indexOf("alice pushed: main"));
    // A fork's own feed says what it was forked from.
    const forks = await fetch(`${base}/bob/game/activity.atom`).then((r) =>
      r.text(),
    );
    expect(forks).toContain("bob forked a repository: alice/game");
    // Every entry has an id, and ids are unique.
    const ids = [...body.matchAll(/<id>(urn:forge:event:[^<]+)<\/id>/g)].map(
      (m) => m[1]!,
    );
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("configuration never enters a feed, even for an admin", async () => {
    for (const headers of [
      {},
      {
        authorization: `Bearer ${createToken(app.db, alice.id, "t", "admin").token}`,
      },
    ]) {
      const body = await fetch(`${base}/alice/game/activity.atom`, {
        headers,
      }).then((r) => r.text());
      expect(body).not.toContain("hooks.example.test");
      expect(body).not.toContain("webhook");
    }
  });

  test("a private repository's feed is its readers' alone, and says so to caches", async () => {
    expect((await fetch(`${base}/alice/secret/activity.atom`)).status).toBe(
      404,
    );
    const bobs = createToken(app.db, bob.id, "t", "ro").token;
    expect(
      (
        await fetch(`${base}/alice/secret/activity.atom`, {
          headers: { authorization: `Bearer ${bobs}` },
        })
      ).status,
    ).toBe(404);
    const alices = createToken(app.db, alice.id, "t", "ro").token;
    const mine = await fetch(`${base}/alice/secret/activity.atom`, {
      headers: { authorization: `Bearer ${alices}` },
    });
    expect(mine.status).toBe(200);
    expect(mine.headers.get("cache-control")).toBe("private, no-store");
    expect(await mine.text()).toContain("alice pushed: main");
    expect((await fetch(`${base}/alice/nothing/activity.atom`)).status).toBe(
      404,
    );
  });

  test("it names its Server-Timing phases", async () => {
    const res = await fetch(`${base}/alice/game/activity.atom`);
    const timing = res.headers.get("server-timing") ?? "";
    for (const name of ["session", "events", "people", "render"])
      expect(timing).toContain(`${name};dur=`);
  });

  test("a repeat request with the ETag answers 304, and a new event a 200", async () => {
    const url = `${base}/alice/game/activity.atom`;
    const first = await fetch(url);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^W\//);
    expect(first.headers.get("vary")).toBe("authorization, cookie, Accept-Encoding");
    await first.text();
    const again = await fetch(url, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("vary")).toBe("authorization, cookie");
    // A different audience never shares the tag.
    const token = createToken(app.db, alice.id, "t", "ro").token;
    const mine = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(mine.headers.get("etag")).not.toBe(etag);
    await mine.text();
    const repo = getRepo(app.db, "alice", "game")!;
    const made = openIssue(app, bob, repo, { title: "a fresh one" });
    if (!made.ok) throw new Error(String(made.error));
    const after = await fetch(url, { headers: { "if-none-match": etag } });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
    expect(await after.text()).toContain("a fresh one");
  });

  test("a retitled issue changes the tag though no event arrived", async () => {
    const url = `${base}/alice/game/activity.atom`;
    const first = await fetch(url);
    const etag = first.headers.get("etag")!;
    await first.text();
    const repo = getRepo(app.db, "alice", "game")!;
    const issue = getIssue(app.db, repo.id, 1)!;
    const edited = editIssue(app, bob, repo, issue, { title: "renamed quietly" });
    if (!edited.ok) throw new Error(String(edited.error));
    const after = await fetch(url, { headers: { "if-none-match": etag } });
    expect(after.status).toBe(200);
    expect(await after.text()).toContain("renamed quietly");
  });

  test("an edited description changes the tag though no event arrived", async () => {
    const url = `${base}/alice/game/activity.atom`;
    const first = await fetch(url);
    const etag = first.headers.get("etag")!;
    await first.text();
    const repo = getRepo(app.db, "alice", "game")!;
    const done = await updateRepoSettings(app, alice, repo, {
      description: "a quieter subtitle",
    });
    if (!done.ok) throw new Error(String(done.error));
    const after = await fetch(url, { headers: { "if-none-match": etag } });
    expect(after.status).toBe(200);
    expect(await after.text()).toContain("<subtitle>a quieter subtitle</subtitle>");
  });

  test("a matching If-None-Match never gets a 304 before the read check", async () => {
    const alices = createToken(app.db, alice.id, "t", "ro").token;
    const mine = await fetch(`${base}/alice/secret/activity.atom`, {
      headers: { authorization: `Bearer ${alices}` },
    });
    const etag = mine.headers.get("etag")!;
    expect(etag).toBeTruthy();
    await mine.text();
    for (const headers of [
      { "if-none-match": etag },
      { "if-none-match": "*" },
    ])
      expect(
        (await fetch(`${base}/alice/secret/activity.atom`, { headers }))
          .status,
      ).toBe(404);
  });

  test("the repository's page advertises its feed", async () => {
    const html = await fetch(`${base}/alice/game`).then((r) => r.text());
    expect(html).toMatch(
      /rel="alternate"\s+type="application\/atom\+xml"\s+title="alice\/game activity"\s+href="\/alice\/game\/activity\.atom"/,
    );
  });
});
