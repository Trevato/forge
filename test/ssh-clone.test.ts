/**
 * The SSH clone address comes from one builder, `sshCloneUrl`, and every
 * surface that prints it — the repository page's About, the terminal's
 * About, the pins API — shows exactly what it says: nothing when SSH is off
 * (`sshPort` unset or `0`, as on a forge hosted as an app) or the forge is
 * hosted, `ssh://git@<host>:<port>/…` otherwise, and no port at 22.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createRepo } from "../src/actions/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import { pin } from "../src/core/pins.ts";
import { createSession } from "../src/core/sessions.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { sshCloneUrl } from "../src/ssh/command.ts";
import { cloneFacts } from "../src/tui/screens/about.ts";
import type { Session } from "../src/tui/session.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("sshCloneUrl", () => {
  let dataDir: string;
  let app: App;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-sshclone-"));
    app = createApp({ dataDir, port: 0, host: "forge.example" });
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("is undefined without a listener, or on port 0", () => {
    delete app.config.sshPort;
    expect(sshCloneUrl(app, "ada", "notes")).toBeUndefined();
    app.config.sshPort = 0;
    expect(sshCloneUrl(app, "ada", "notes")).toBeUndefined();
  });

  test("names host and port, and leaves port 22 out", () => {
    app.config.sshPort = 2222;
    expect(sshCloneUrl(app, "ada", "notes")).toBe(
      "ssh://git@forge.example:2222/ada/notes.git",
    );
    app.config.sshPort = 22;
    expect(sshCloneUrl(app, "ada", "notes")).toBe(
      "ssh://git@forge.example/ada/notes.git",
    );
  });

  test("is undefined on a hosted forge, whatever its port", () => {
    app.config.sshPort = 2222;
    app.config.appSsh = "ssh -p 2222 lab@host.example";
    try {
      expect(sshCloneUrl(app, "ada", "notes")).toBeUndefined();
    } finally {
      delete app.config.appSsh;
    }
  });
});

describe("the clone address on the repository page, in the terminal and in the pins API", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let repo: Repo;
  let cookie = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-sshclone-page-"));
    app = createApp({
      dataDir,
      port: 0,
      host: "forge.example",
      url: "https://forge.example",
    });
    servers = await serve(app);
    const ada = await seedAdmin(app, { username: "ada", email: "ada@forge.example" });
    if (!ada.ok) throw new Error(ada.error);
    const made = await createRepo(app, ada.value, { name: "notes", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    pin(app.db, ada.value.id, repo.id);
    cookie = `forge_session=${createSession(app.db, ada.value.id).token}`;
    // An empty repository has no About card; one commit gives it one.
    const c = await commitFiles(repoDir(app.reposRoot, "ada", "notes"), {
      branch: "main",
      message: "first",
      files: [{ path: "README.md", content: "# notes\n" }],
      author: { name: "ada", email: "ada@forge.example" },
    });
    if (!c.ok) throw new Error("no commit");
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const page = async (): Promise<string> => {
    const res = await fetch(`${servers.url}/ada/notes`);
    expect(res.status).toBe(200);
    return res.text();
  };
  const pinned = async (): Promise<string | null> => {
    const res = await fetch(`${servers.url}/api/v1/user/pins`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { sshUrl: string | null }[] };
    return body.items[0]!.sshUrl;
  };
  const terminal = (): [string, string][] =>
    cloneFacts({ app } as unknown as Session, repo);

  test("with sshPort 0 neither shows an ssh line", async () => {
    app.config.sshPort = 0;
    expect(await page()).not.toContain('id="clone-ssh"');
    expect(terminal().map(([k]) => k)).toEqual(["clone (http)"]);
    expect(await pinned()).toBeNull();
  });

  test("with sshPort 2222 both show the same address", async () => {
    app.config.sshPort = 2222;
    const want = "ssh://git@forge.example:2222/ada/notes.git";
    const html = await page();
    expect(html).toMatch(/<input[^>]*\bid="clone-ssh"/);
    expect(html).toContain(want);
    expect(terminal()).toContainEqual(["clone (ssh)", want]);
    expect(await pinned()).toBe(want);
  });

  test("on a hosted forge none shows an ssh address, whatever its port", async () => {
    app.config.sshPort = 2222;
    app.config.appSsh = "ssh -p 2222 lab@host.example";
    try {
      expect(await page()).not.toContain('id="clone-ssh"');
      expect(terminal().map(([k]) => k)).toEqual(["clone (http)"]);
      expect(await pinned()).toBeNull();
    } finally {
      delete app.config.appSsh;
    }
  });

  test("with port 22 the address has no port", async () => {
    app.config.sshPort = 22;
    const want = "ssh://git@forge.example/ada/notes.git";
    expect(await page()).toContain(want);
    expect(terminal()).toContainEqual(["clone (ssh)", want]);
    expect(await pinned()).toBe(want);
  });

  test("the terminal's HTTP clone is the forge's public address", () => {
    expect(terminal()[0]).toEqual([
      "clone (http)",
      "https://forge.example/ada/notes.git",
    ]);
  });
});
