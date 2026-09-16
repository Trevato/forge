/**
 * The studio: apps as the unit, three verbs, and a switch to dev. The same
 * URLs answer in both modes; the cookie decides which face they show.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { enableApp } from "../src/actions/apps.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getIssue, listIssues } from "../src/core/issues.ts";
import { getPull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("the studio", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;
  let repo: Repo;
  let cookie: string;

  const get = (path: string, extra: Record<string, string> = {}) =>
    fetch(`${base}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio`, ...extra },
      redirect: "manual",
    });
  const post = (path: string, body: Record<string, string>, extra = "") =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { cookie: `${cookie}${extra}`, origin: base },
      body: new URLSearchParams(body),
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-studio-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    cookie = (
      (
        await fetch(`${base}/signin`, {
          method: "POST",
          body: new URLSearchParams({
            username: "alice",
            password: "a-good-passphrase",
          }),
          redirect: "manual",
        })
      ).headers.get("set-cookie") ?? ""
    ).split(";")[0]!;
    const made = await createRepo(app, alice, {
      name: "notes",
      visibility: "private",
      description: "a place for notes",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [
        {
          path: "package.json",
          content: '{"name":"notes","scripts":{"start":"bun run server.ts"}}\n',
        },
        {
          path: "server.ts",
          content:
            "Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response('ok') });\n",
        },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const enabled = await enableApp(app, alice, repo, { slug: "notes" });
    if (!enabled.ok) throw new Error(String(enabled.error));
    const scout = await createAgent(app, alice, { username: "scout" });
    if (!scout.ok) throw new Error(String(scout.error));
    expect(addToCrew(app, alice, repo, "scout").ok).toBe(true);
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("home is the studio with the cookie and the repositories without; the switch is a cookie", async () => {
    const plain = await (
      await fetch(`${base}/`, { headers: { cookie } })
    ).text();
    expect(plain).not.toContain("<h1>Studio</h1>");
    const home = await (await get("/")).text();
    expect(home).toContain("Studio");
    expect(home).toContain("notes");
    expect(home).toContain("New app");
    const dev = await (await get("/?mode=dev")).text();
    expect(dev).not.toContain("<h1>Studio</h1>");
    const flipped = await post("/mode", { mode: "dev", back: "/" });
    expect(flipped.status).toBe(303);
    expect(flipped.headers.get("set-cookie")).toContain("forge_mode=dev");
    const asDev = await (
      await get("/", { cookie: `${cookie}; forge_mode=dev` })
    ).text();
    expect(asDev).not.toContain("<h1>Studio</h1>");
    const bad = await post("/mode", { mode: "neither", back: "/" });
    expect(bad.headers.get("set-cookie")).toContain("forge_mode=;");
  });

  test("an app's home is the app in the studio, and the code in dev", async () => {
    const studio = await (await get("/alice/notes")).text();
    expect(studio).toContain("Tell the crew");
    expect(studio).toContain("<h2>Crew</h2>");
    expect(studio).toContain(">Studio<");
    expect(studio).not.toContain(">Commits<");
    const dev = await (
      await get("/alice/notes", { cookie: `${cookie}; forge_mode=dev` })
    ).text();
    expect(dev).not.toContain("Tell the crew");
    expect(dev).toContain(">Commits<");
  });

  test("telling the crew opens an issue and hands it to a builder", async () => {
    const told = await post("/alice/notes/tell", {
      text: "Make the notes page load in under a second on my phone.\n\nIt takes three seconds now.",
    });
    expect(told.status).toBe(303);
    const issue = listIssues(app.db, repo.id, { kind: "issue", limit: 5 })[0]!;
    expect(issue.title).toBe(
      "Make the notes page load in under a second on my phone.",
    );
    expect(issue.body).toContain("three seconds");
    expect(issue.assigneeName).toBe("scout");
    const again = await (await get("/alice/notes")).text();
    expect(again).toContain("waiting");
    expect(again).toContain(">scout<");
    const empty = await post("/alice/notes/tell", { text: "   " });
    expect(empty.status).toBe(303);
  });

  test("ship lands a change; say tells the crew", async () => {
    const branch = await commitToBranch(app, alice, repo, {
      branch: "feature/fast",
      base: "main",
      message: "Faster",
      files: [{ path: "FAST.md", content: "fast\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    const opened = await openPull(app, alice, repo, {
      title: "Faster",
      body: "Closes #1",
      baseBranch: "main",
      headBranch: "feature/fast",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const said = await post(`/alice/notes/pulls/${pull.number}/say`, {
      text: "Keep the images lazy too.",
    });
    expect(said.status).toBe(303);
    const check = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, check.id);
    finishRun(app.db, check.id, { state: "ok", summary: "check passed in 1s" });
    // A bare POST — a button with no fields, or a client that sent no body
    // at all — ships too: an empty form is not a bad request.
    const shipped = await fetch(
      `${base}/alice/notes/pulls/${pull.number}/ship`,
      {
        method: "POST",
        headers: { cookie: `${cookie}; forge_mode=studio`, origin: base },
        redirect: "manual",
      },
    );
    expect(shipped.status).toBe(303);
    expect(getPull(app.db, repo.id, pull.number)?.mergedAt).not.toBeNull();
    expect(getIssue(app.db, repo.id, 1)?.state).toBe("closed");
    const page = await (await get("/alice/notes")).text();
    expect(page).toContain("shipped");
    // What was told and then shipped is not still "waiting" in Now.
    expect(page).not.toContain(">waiting<");
    expect(getUserByName(app.db, "scout")).toBeDefined();
  });
});
