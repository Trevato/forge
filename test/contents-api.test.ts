import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitLog, listTree } from "../src/git/read.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { unwrap } from "../src/kernel/result.ts";

describe("commit via API (no git client)", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let token = "";
  let repoGitDir = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-contents-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    await fetch(`${base}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "bot",
        email: "bot@f.dev",
        password: "contents-api-pass",
      }),
    });
    token = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "bot",
        password: "contents-api-pass",
        name: "c",
        scope: "rw",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    await fetch(`${base}/api/v1/repos`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "app", visibility: "public" }),
    });
    repoGitDir = repoDir(join(dataDir, "repos"), "bot", "app");
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const commit = (payload: unknown) =>
    fetch(`${base}/api/v1/repos/bot/app/contents`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

  test("first commit creates the default branch from an empty repo", async () => {
    const res = await commit({
      message: "initial",
      files: [
        { path: "README.md", content: "# app\n" },
        { path: "src/index.ts", content: "export const hi = 1;\n" },
      ],
    });
    expect(res.status).toBe(201);
    const out = (await res.json()) as { created: boolean; branch: string };
    expect(out.created).toBe(true);
    expect(out.branch).toBe("main");

    // Git sees a real commit and tree.
    const log = unwrap(await commitLog(repoGitDir, "main"));
    expect(log[0]?.subject).toBe("initial");
    const tree = unwrap(await listTree(repoGitDir, "main", ""));
    expect(tree.map((e) => e.name).sort()).toEqual(["README.md", "src"]);
  });

  test("a second commit fast-forwards and shows in the log + UI", async () => {
    const res = await commit({
      message: "add license",
      files: [{ path: "LICENSE", content: "MIT\n" }],
    });
    expect(res.status).toBe(201);
    const log = unwrap(await commitLog(repoGitDir, "main"));
    expect(log.length).toBe(2);
    expect(log[0]?.subject).toBe("add license");
    // The file browser renders it (highlighted).
    const page = await (
      await fetch(`${base}/bot/app/blob/main/src/index.ts`)
    ).text();
    expect(page).toContain("hi");
  });

  test("committing to a new branch, then opening a PR from it", async () => {
    const branched = await commit({
      branch: "feature",
      message: "shout",
      files: [{ path: "README.md", content: "# APP\n" }],
    });
    expect(branched.status).toBe(201);
    expect(((await branched.json()) as { created: boolean }).created).toBe(
      true,
    );

    // The branch is a real head a PR can be opened against.
    const form = new URLSearchParams({
      base: "main",
      head: "feature",
      title: "Shout",
      body: "",
    });
    // Need a session (web form) to open a PR; log in.
    const cookie = await fetch(`${base}/api/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "bot", password: "contents-api-pass" }),
    }).then((r) => (r.headers.get("set-cookie") ?? "").split(";")[0]!);
    const pr = await fetch(`${base}/bot/app/pulls/new`, {
      method: "POST",
      headers: { cookie },
      body: form,
      redirect: "manual",
    });
    expect(pr.status).toBe(303);
    const prPage = await (
      await fetch(`${base}${pr.headers.get("location")}`, {
        headers: { cookie },
      })
    ).text();
    expect(prPage).toContain("Ready to merge");
  });

  test("a push event fires so the outbox/webhooks/SSE see API commits", async () => {
    const events = await (
      await fetch(`${base}/api/v1/repos/bot/app/events`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    const list = events as { kind: string; payload: { viaApi?: boolean } }[];
    expect(
      list.some((e) => e.kind === "push" && e.payload.viaApi === true),
    ).toBe(true);
  });

  test("path traversal in a committed file is refused", async () => {
    const res = await commit({
      message: "evil",
      files: [{ path: "../escape", content: "x" }],
    });
    expect(res.status).toBe(422);
  });

  test("a read-only token cannot commit", async () => {
    const roToken = await fetch(`${base}/api/v1/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "bot",
        password: "contents-api-pass",
        name: "ro",
        scope: "ro",
      }),
    })
      .then((r) => r.json())
      .then((j) => (j as { token: string }).token);
    const res = await fetch(`${base}/api/v1/repos/bot/app/contents`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${roToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: "no",
        files: [{ path: "x", content: "y" }],
      }),
    });
    expect(res.status).toBe(403);
  });
});
