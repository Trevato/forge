/**
 * A `.gpx` committed to a repository, opened on its blob page over HTTP by
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

describe("a .gpx on its blob page", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let base = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-blob-gpx-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await seedAdmin(app, { username: "alice", email: "a@f.dev", password: "a-long-patch-passphrase" });
    if (!a.ok) throw new Error("signup failed");
    const created = await createRepo(app, a.value, { name: "p", visibility: "public" });
    if (!created.ok) throw new Error("repo failed");
    const fixture = '<gpx><trk><name>Up &lt;b&gt;x&lt;/b&gt;</name><trkseg><trkpt lat="10" lon="20"><ele>100</ele></trkpt><trkpt lat="11" lon="20"><ele>150</ele></trkpt></trkseg></trk></gpx>';
    const made = await commitToBranch(app, a.value, created.value, {
      message: "a track",
      files: [{ path: "ride.gpx", content: fixture }],
    });
    if (!made.ok) throw new Error("commit failed");
  }, 60_000);

  afterAll(async () => {
    await servers?.stop();
    app?.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the page draws the route, scalable, with its facts as rows", async () => {
    const res = await fetch(`${base}/alice/p/blob/main/ride.gpx`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).toContain('class="gpx-view"');
    expect(text).toMatch(/<svg viewBox="0 0 \d+ \d+" role="img"/);
    expect(text).toContain('<dt>Distance</dt><dd>111.2 km</dd>');
    expect(text).toContain('<dt>Climb</dt><dd>50 m</dd>');
    expect(text).toContain('Up &lt;b&gt;x&lt;/b&gt;');
    expect(text).not.toContain('<b>x');
  });
});
