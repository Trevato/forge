/**
 * A `.ipynb` committed to a repository, opened on its blob page over HTTP by
 * an anonymous reader: the server-rendered route and its facts as rows.
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

describe("a .ipynb on its blob page", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let base = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-blob-ipynb-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await seedAdmin(app, { username: "alice", email: "a@f.dev", password: "a-long-patch-passphrase" });
    if (!a.ok) throw new Error("signup failed");
    const created = await createRepo(app, a.value, { name: "p", visibility: "public" });
    if (!created.ok) throw new Error("repo failed");
    const small = JSON.stringify({
      cells: [{ cell_type: "code", execution_count: 1, source: "1", outputs: [{ output_type: "execute_result", data: { "text/html": "<script>alert(1)</script>" } }] }],
    });
    const big = JSON.stringify({ cells: [{ cell_type: "markdown", source: "x".repeat(1_100_000) }] });
    const made = await commitToBranch(app, a.value, created.value, {
      message: "notebooks",
      files: [
        { path: "ok.ipynb", content: small },
        { path: "big.ipynb", content: big },
        { path: "bad.ipynb", content: "{not json" },
      ],
    });
    if (!made.ok) throw new Error("commit failed");
  }, 60_000);

  afterAll(async () => {
    await servers?.stop();
    app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a notebook is drawn as cells, its script output escaped", async () => {
    const text = await (await fetch(`${base}/alice/p/blob/main/ok.ipynb`)).text();
    expect(text).toContain("In [1]:");
    expect(text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(text).not.toContain("<script>alert(1)");
  });

  test("over 1 MB, the page says why it is not drawn as cells", async () => {
    const res = await fetch(`${base}/alice/p/blob/main/big.ipynb`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain("This notebook is over 1 MB, so it is not drawn as cells");
    expect(text).not.toContain("In [");
  });

  test("invalid JSON says why on the page", async () => {
    const text = await (await fetch(`${base}/alice/p/blob/main/bad.ipynb`)).text();
    expect(text).toContain("not valid JSON");
  });
});
