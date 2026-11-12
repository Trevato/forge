/**
 * A workflow committed to a repository, opened on its blob page over HTTP: drawn as jobs, escaped,
 * and a broken one shown as YAML with the reason and the Source link.
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

describe("a workflow on its blob page", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let base = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-blob-workflow-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await seedAdmin(app, { username: "alice", email: "a@f.dev", password: "a-long-patch-passphrase" });
    if (!a.ok) throw new Error("signup failed");
    const created = await createRepo(app, a.value, { name: "p", visibility: "public" });
    if (!created.ok) throw new Error("repo failed");
    const made = await commitToBranch(app, a.value, created.value, {
      message: "workflows",
      files: [
        { path: ".github/workflows/ok.yml", content: "on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - name: <script>alert(1)</script>\n        run: bun test\n" },
        { path: ".github/workflows/bad.yml", content: "a: [\n" },
      ],
    });
    if (!made.ok) throw new Error("commit failed");
  }, 60_000);

  afterAll(async () => {
    await servers?.stop();
    app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a workflow is drawn as jobs, its step name escaped", async () => {
    const text = await (await fetch(`${base}/alice/p/blob/main/.github/workflows/ok.yml`)).text();
    expect(text).toContain("workflow-view");
    expect(text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(text).not.toContain("<script>alert(1)");
  });

  test("a broken one shows its YAML with one plain line, and Source is one click away", async () => {
    const text = await (await fetch(`${base}/alice/p/blob/main/.github/workflows/bad.yml`)).text();
    expect(text).not.toContain("workflow-view");
    expect(text).toContain("This file is shown as YAML because it is not drawn as a workflow: it is not valid YAML");
    expect(text).toContain("bad.yml?view=source");
    expect(text).toContain('<tr id="L1">');
  });
});
