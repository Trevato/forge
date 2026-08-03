import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { listLabels } from "../src/core/issues.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("repo settings", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let ownerCookie = "";
  let strangerCookie = "";

  const form = (fields: Record<string, string>) => new URLSearchParams(fields);

  async function signup(username: string): Promise<string> {
    const res = await fetch(`${base}/signup`, {
      method: "POST",
      body: form({
        username,
        email: `${username}@f.dev`,
        password: "settings-password",
      }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-settings-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    ownerCookie = await signup("owner");
    strangerCookie = await signup("stranger");
    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie: ownerCookie },
      body: form({ name: "proj", visibility: "private", description: "start" }),
      redirect: "manual",
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("only the owner can reach settings", async () => {
    expect(
      (
        await fetch(`${base}/owner/proj/settings`, {
          headers: { cookie: ownerCookie },
        })
      ).status,
    ).toBe(200);
    // A stranger can't even see the private repo exists.
    expect(
      (
        await fetch(`${base}/owner/proj/settings`, {
          headers: { cookie: strangerCookie },
        })
      ).status,
    ).toBe(404);
    expect((await fetch(`${base}/owner/proj/settings`)).status).toBe(404);
  });

  test("owner updates visibility, description, and protection", async () => {
    const res = await fetch(`${base}/owner/proj/settings`, {
      method: "POST",
      headers: { cookie: ownerCookie },
      body: form({
        visibility: "public",
        description: "now public",
        protect: "on",
      }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    const repo = getRepo(app.db, "owner", "proj")!;
    expect(repo.visibility).toBe("public");
    expect(repo.description).toBe("now public");
    expect(repo.protectDefault).toBe(true);
  });

  test("a stranger cannot change settings", async () => {
    const res = await fetch(`${base}/owner/proj/settings`, {
      method: "POST",
      headers: { cookie: strangerCookie },
      body: form({ visibility: "private", description: "hijacked" }),
      redirect: "manual",
    });
    expect(res.status).toBe(404);
    expect(getRepo(app.db, "owner", "proj")!.description).toBe("now public");
  });

  test("create and delete labels", async () => {
    await fetch(`${base}/owner/proj/settings/labels`, {
      method: "POST",
      headers: { cookie: ownerCookie },
      body: form({ name: "bug", color: "d73a4a" }),
      redirect: "manual",
    });
    let labels = listLabels(app.db, getRepo(app.db, "owner", "proj")!.id);
    expect(labels.map((l) => l.name)).toContain("bug");
    const labelId = labels.find((l) => l.name === "bug")!.id;

    // The label shows on the settings page with its color bound via nonce'd CSS.
    const pageHtml = await (
      await fetch(`${base}/owner/proj/settings`, {
        headers: { cookie: ownerCookie },
      })
    ).text();
    expect(pageHtml).toContain("lc-d73a4a");
    expect(pageHtml).toContain(".lc-d73a4a{--label:#d73a4a}");

    await fetch(`${base}/owner/proj/settings/labels/${labelId}/delete`, {
      method: "POST",
      headers: { cookie: ownerCookie },
      body: form({}),
      redirect: "manual",
    });
    labels = listLabels(app.db, getRepo(app.db, "owner", "proj")!.id);
    expect(labels.map((l) => l.name)).not.toContain("bug");
  });

  test("cross-origin settings update is refused", async () => {
    const res = await fetch(`${base}/owner/proj/settings`, {
      method: "POST",
      headers: { cookie: ownerCookie, origin: "http://evil.example" },
      body: form({ visibility: "private" }),
      redirect: "manual",
    });
    expect(res.status).toBe(403);
  });
});
