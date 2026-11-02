/**
 * Forking when the copy fails (#7175): the answer is a refusal in words,
 * not a 500, and nothing is left behind — no repository row, no directory.
 * Once the target is writable again, the same name forks.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";

describe("forking when the copy fails", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let token: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-fork-failed-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const users = [];
    for (const [name, first] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: name,
        email: `${name}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!made.ok) throw new Error(made.error);
      users.push(made.value);
    }
    promote(app.db, users[1]!);
    const lib = await createRepo(app, users[0]!, { name: "lib", visibility: "public" });
    if (!lib.ok) throw new Error(String(lib.error));
    const seeded = await commitToBranch(app, users[0]!, lib.value, {
      message: "Start",
      files: [{ path: "README.md", content: "# lib\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    token = tokenFor(app, "bob", "rw");
  });

  afterAll(async () => {
    await chmod(app.reposRoot, 0o755).catch(() => {});
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const fork = () =>
    fetch(`${servers.url}/api/v1/repos/alice/lib/forks`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
    });

  test("a failed copy is a refusal in words and leaves nothing behind", async () => {
    const before = (await readdir(app.reposRoot)).sort();
    await chmod(app.reposRoot, 0o555);
    let res: Response;
    try {
      res = await fork();
    } finally {
      await chmod(app.reposRoot, 0o755);
    }
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message?: string };
    expect(body.error).toBe("fork_failed");
    expect(body.message).toBe("the fork could not be created");
    expect(
      app.db.query("SELECT 1 FROM repo WHERE name = 'lib' AND owner_id != (SELECT id FROM user WHERE username = 'alice')").get(),
    ).toBeNull();
    expect((await readdir(app.reposRoot)).sort()).toEqual(before);
  });

  test("once the target is writable, the same name forks", async () => {
    const res = await fork();
    expect(res.status).toBe(201);
    const made = (await res.json()) as { name: string; ownerName: string };
    expect(made.name).toBe("lib");
    expect(made.ownerName).toBe("bob");
  });
});
