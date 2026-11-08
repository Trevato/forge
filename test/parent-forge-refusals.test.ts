/**
 * Proposing to the parent forge (#7116): a forge with no parent link, a
 * repository that is not the one linked, and a link with no stored
 * credential are each refused as `no_parent_forge`, and nothing is sent to
 * the parent — not a push, not a pull.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { proposeToParentForge } from "../src/actions/upstream.ts";
import { createApp, type App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { keepParentCredential } from "../src/spawn/parent_credential.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("proposing to a parent forge that is not there for this repository", () => {
  let dir = "";
  let stub: ReturnType<typeof Bun.serve>;
  let seen: string[] = [];
  let n = 0;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-noparent-"));
    stub = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        seen.push(`${req.method} ${new URL(req.url).pathname}`);
        return new Response("{}", { status: 500 });
      },
    });
  });

  afterAll(async () => {
    await stub.stop(true);
    await rm(dir, { recursive: true, force: true });
  });

  /** A child forge with one repository that has a commit to propose. */
  const child = async (
    owner: string,
    name: string,
    parentDoc?: (tip: string) => Record<string, unknown>,
  ): Promise<{ app: App; user: User; repo: Repo }> => {
    const app = createApp({ dataDir: join(dir, `c${n++}`), port: 0, host: "kid.test" });
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: owner,
      email: `${owner}@forge.local`,
      password: "a-long-refusal-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const repo = await createRepo(app, made.value, { name, visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    const c = await commitToBranch(app, made.value, repo.value, {
      branch: "main",
      message: "Start",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    if (parentDoc !== undefined)
      await Bun.write(join(app.config.dataDir, "parent.json"), JSON.stringify(parentDoc("")));
    return { app, user: made.value, repo: repo.value };
  };

  const doc = (repo: string): Record<string, unknown> => ({
    upstream: `http://127.0.0.1:${stub.port}`,
    name: "kid",
    forgeCode: { repo, upstream: "alice/app", mode: "tell-me", tip: "", chain: [] },
  });

  const refused = async (c: { app: App; user: User; repo: Repo }) => {
    seen = [];
    const r = await proposeToParentForge(c.app, c.user, c.repo);
    expect(r.ok ? "ok" : r.error).toBe("no_parent_forge");
    expect(seen).toEqual([]);
  };

  test("a forge with no parent.json is refused", async () => {
    await refused(await child("kid", "app"));
  });

  test("a forge linked to alice/app proposing from bob/other is refused", async () => {
    const c = await child("bob", "other", () => doc("alice/app"));
    const kept = await keepParentCredential(c.app, { child: "kid", token: "a-proposal-token-1" });
    if (!kept.ok) throw new Error(kept.error);
    await refused(c);
  });

  test("a link with no stored credential is refused", async () => {
    await refused(await child("alice", "app", () => doc("alice/app")));
  });

  test("the same link with a credential gets past the refusal", async () => {
    const c = await child("alice", "app", () => doc("alice/app"));
    const kept = await keepParentCredential(c.app, { child: "kid", token: "a-proposal-token-1" });
    if (!kept.ok) throw new Error(kept.error);
    seen = [];
    const r = await proposeToParentForge(c.app, c.user, c.repo);
    expect(r.ok ? "ok" : r.error).not.toBe("no_parent_forge");
  });
});
