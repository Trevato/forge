/**
 * Settings › Labels says how many open issues carry each label, links to the
 * list narrowed to it, and the delete confirm names the count.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createIssue, createLabel, openLabelCounts, setIssueLabels, setIssueState } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { mcpTool } from "./helpers/mcp.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";

describe("labels page counts", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let cookie = "";
  let repoId = "";
  let bugId = "";
  let idleId = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-label-counts-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    cookie = await adminCookie(app, { username: "olive", email: "olive@f.dev", password: "label-counts-password" });
    await fetch(`${servers.url}/new`, {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ name: "proj", visibility: "private", description: "" }),
      redirect: "manual",
    });
    const repo = app.db.query<{ id: string; author: string }, []>("SELECT id, owner_id AS author FROM repo").get()!;
    repoId = repo.id;
    const bug = createLabel(app.db, repoId, "bug fix", "d73a4a");
    const idle = createLabel(app.db, repoId, "idle", "6b7280");
    if (!bug.ok || !idle.ok) throw new Error("labels");
    bugId = bug.value.id;
    idleId = idle.value.id;
    for (const title of ["a", "b", "c"]) {
      const made = createIssue(app.db, { repoId, authorId: repo.author, title });
      if (!made.ok) throw new Error(made.error);
      setIssueLabels(app.db, made.value.id, [bugId]);
      if (title === "c") setIssueState(app.db, made.value.id, "closed");
    }
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("openLabelCounts counts open items only, one entry per used label", () => {
    const counts = openLabelCounts(app.db, repoId);
    expect(counts.get(bugId)).toBe(2);
    expect(counts.has(idleId)).toBe(false);
  });

  test("the page says 2 open as a link, and unused for the other", async () => {
    const res = await fetch(`${servers.url}/olive/proj/settings/labels`, { headers: { cookie } });
    const text = await res.text();
    expect(text).toContain("2 open");
    expect(text).toContain('href="/olive/proj/issues?label=bug%20fix"');
    expect(text).toContain("unused");
    expect(res.headers.get("server-timing")).toContain("counts");
  });

  test("the delete confirm names the count, and says nothing for an unused label", async () => {
    const confirm = async (id: string) =>
      (
        await fetch(
          `${servers.url}/-/confirm?to=${encodeURIComponent(`/olive/proj/settings/labels/${id}/delete`)}`,
          { headers: { cookie } },
        )
      ).text();
    expect(await confirm(bugId)).toContain("2 open items carry it.");
    expect(await confirm(idleId)).not.toContain("carry it.");
  });

  test("both doors list each label with its open count, for a writer", async () => {
    const owner = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'olive'").get()!;
    const token = createToken(app.db, owner.id, "t", "ro").token;
    const res = await fetch(`${servers.url}/api/v1/repos/olive/proj/labels`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const api = ((await res.json()) as any).items as Array<{ id: string; open: number }>;
    expect(api.find((l) => l.id === bugId)?.open).toBe(2);
    expect(api.find((l) => l.id === idleId)?.open).toBe(0);
    const mcp = await mcpTool(servers.url, token, "repo_labels", { repo: "olive/proj" });
    expect(mcp.value.items.find((l: any) => l.id === bugId).open).toBe(2);
  });
});
