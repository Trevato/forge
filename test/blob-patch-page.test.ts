/**
 * A `.patch` committed to a repository, opened on its blob page over HTTP by
 * an anonymous reader: the server-rendered page (no script needed) carries the
 * mail header and the pull page's diff markup.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("a .patch on its blob page", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let base = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-blob-patch-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await seedAdmin(app, { username: "alice", email: "a@f.dev", password: "a-long-patch-passphrase" });
    if (!a.ok) throw new Error("signup failed");
    const created = await createRepo(app, a.value, { name: "p", visibility: "public" });
    if (!created.ok) throw new Error("repo failed");
    const fixture = await Bun.file(new URL("./fixtures/format-patch.patch", import.meta.url)).text();
    const made = await commitToBranch(app, a.value, created.value, {
      message: "a patch",
      files: [{ path: "fix.patch", content: fixture }],
    });
    if (!made.ok) throw new Error("commit failed");
  }, 60_000);

  afterAll(async () => {
    await servers?.stop();
    app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the page answers with the header rows and both files drawn as a diff", async () => {
    const res = await fetch(`${base}/alice/p/blob/main/fix.patch`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain('<dt class="muted">Subject</dt><dd>[PATCH] Greet by name, and add a notes file</dd>');
    expect(text).toContain('<dt class="muted">From</dt><dd>Ann Example &lt;ann@example.com&gt;</dd>');
    expect(text).toContain("greet.ts");
    expect(text).toContain("notes.md");
    expect(text).toMatch(/class="[^"]*\badd\b/);
    expect(text).toMatch(/class="[^"]*\bdel\b/);
    expect(text).not.toContain("<b>names");
    expect(text).toContain("&lt;b&gt;names");
    expect(text).not.toContain("is not a git unified diff");
  });
});
