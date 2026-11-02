/**
 * Stop mirroring asks first (#7979): the settings page links the button to
 * the confirm page, which names the mirror and says nothing more is pushed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getMirrorTarget, setMirrorTarget } from "../src/core/migrate_mirror.ts";
import { createRepo, type Repo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("stop mirroring goes through the confirm page", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let cookie: string;
  let bobCookie: string;
  let gizmo: Repo;
  const STOP = "/alice/gizmo/settings/mirror/stop";
  const confirmOf = (to: string) => `/-/confirm?to=${encodeURIComponent(to)}`;

  const get = (path: string, as = cookie) =>
    fetch(`${servers.url}${path}`, { headers: { cookie: as }, redirect: "manual" });

  const signIn = async (username: string): Promise<string> => {
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: "mirrors-are-one-way" }),
      redirect: "manual",
    });
    return `${(signin.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=dev`;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-confirm-mirror-stop-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      adminIfFirst: true,
      username: "alice",
      email: "alice@forge.test",
      password: "mirrors-are-one-way",
    });
    if (!made.ok) throw new Error(String(made.error));
    const bob = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.test",
      password: "mirrors-are-one-way",
    });
    if (!bob.ok) throw new Error(String(bob.error));
    for (const [owner, name] of [
      [made.value.id, "gizmo"],
      [made.value.id, "plain"],
    ] as const) {
      const repo = await createRepo(app.db, app.reposRoot, {
        ownerId: owner,
        name,
        visibility: "private",
      });
      if (!repo.ok) throw new Error(String(repo.error));
      if (name === "gizmo") gizmo = repo.value;
    }
    app.db.run("PRAGMA foreign_keys = OFF");
    setMirrorTarget(app.db, {
      repoId: gizmo.id,
      originId: "origin-none",
      fullName: "octo/gizmo",
      cloneUrl: "https://example.test/octo/gizmo.git",
      tips: {},
    });
    cookie = await signIn("alice");
    bobCookie = await signIn("bob");
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  test("the settings page links Stop mirroring to the confirm page, not a bare form", async () => {
    const response = await get("/alice/gizmo/settings");
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("data-mirror-line");
    expect(page).toContain("Stopping leaves octo/gizmo as it is");
    expect(page).toContain(confirmOf(STOP));
    expect(page).not.toContain(`action="${STOP}"`);
  });

  test("the confirm page names the mirror and says nothing more is pushed", async () => {
    const response = await get(confirmOf(STOP));
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("Stop mirroring alice/gizmo to octo/gizmo?");
    expect(page).toContain("octo/gizmo stays as it is; nothing more is pushed to it");
    expect(page).toContain("Only a new migration sets up a mirror again");
  });

  test("someone who cannot administer the repository is not told where it mirrors", async () => {
    const response = await get(confirmOf(STOP), bobCookie);
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("Stop mirroring alice/gizmo?");
    expect(page).not.toContain("octo/gizmo");
  });

  test("a repository that is not mirrored gets the plain wording", async () => {
    const response = await get(confirmOf("/alice/plain/settings/mirror/stop"));
    expect(response.status).toBe(200);
    const page = await response.text();
    expect(page).toContain("Stop mirroring alice/plain?");
    expect(page).toContain("The copy on the other side stays as it is");
    expect(page).not.toContain("octo/gizmo");
  });

  test("confirming posts to the route, which still stops the mirror", async () => {
    const response = await fetch(`${servers.url}${STOP}`, {
      method: "POST",
      headers: { cookie, origin: new URL(servers.url).origin },
      body: new URLSearchParams(),
      redirect: "manual",
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/alice/gizmo/settings");
    expect(getMirrorTarget(app.db, gizmo.id)).toBeUndefined();
  });
});
