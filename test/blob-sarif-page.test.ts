/**
 * A `.sarif` committed to a repository, opened on its blob page over HTTP by
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

describe("a .sarif on its blob page", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let base = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-blob-sarif-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await seedAdmin(app, { username: "alice", email: "a@f.dev", password: "a-long-patch-passphrase" });
    if (!a.ok) throw new Error("signup failed");
    const created = await createRepo(app, a.value, { name: "p", visibility: "public" });
    if (!created.ok) throw new Error("repo failed");
    const fixture = JSON.stringify({
      version: "2.1.0",
      runs: [{ tool: { driver: { name: "T" } }, results: ["src/a.ts", "gone/b.ts"].map((uri, i) => ({ ruleId: "R", level: "error", message: { text: "m" }, locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine: i + 1 } } }] })) }],
    });
    const made = await commitToBranch(app, a.value, created.value, {
      message: "a track",
      files: [{ path: "scan.sarif", content: fixture }, { path: "src/a.ts", content: "x\n" }],
    });
    if (!made.ok) throw new Error("commit failed");
  }, 60_000);

  afterAll(async () => {
    await servers?.stop();
    app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a finding links only to a file that exists at the ref", async () => {
    const res = await fetch(`${base}/alice/p/blob/main/scan.sarif`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain('<a href="/alice/p/blob/main/src/a.ts#L1">src/a.ts:1</a>');
    expect(text).toContain("<td>gone/b.ts:2</td>");
    expect(text).not.toContain("blob/main/gone/b.ts");
  });
});
