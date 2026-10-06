/**
 * The address on commits the forge writes for a person (#623). A commit in a
 * public repository is published in every clone forever, so it carries a
 * no-reply address on the forge's host unless the person opted in to their
 * account email — through the settings page or the API, never by default.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { editFiles } from "../src/actions/contents.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { revertPull } from "../src/actions/revert.ts";
import { updateProfile } from "../src/actions/users.ts";
import {
  commitIdentity,
  forgeHost,
  noreplyAddress,
} from "../src/core/commit_identity.ts";
import type { Repo } from "../src/core/repos.ts";
import {
  createUser,
  getUserByName,
  updateProfile as writeProfile,
  type User,
} from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("commitIdentity", () => {
  const person = {
    username: "alice",
    displayName: "Alice",
    email: "alice@private.test",
    kind: "user" as const,
  };

  test("a person's default is the no-reply address on the forge's host", () => {
    expect(
      commitIdentity(
        { host: "forge.example" },
        { ...person, commitEmail: "noreply" },
      ),
    ).toEqual({ name: "Alice", email: "alice@users.noreply.forge.example" });
  });

  test("the account email only when the person opted in", () => {
    expect(
      commitIdentity({}, { ...person, commitEmail: "account" }).email,
    ).toBe("alice@private.test");
  });

  test("the public URL's host outranks the bind host, and has no port", () => {
    expect(
      forgeHost({ url: "https://forge.open-platform.sh:8443", host: "0.0.0.0" }),
    ).toBe("forge.open-platform.sh");
    expect(forgeHost({})).toBe("localhost");
    expect(noreplyAddress("bob", "f.dev")).toBe("bob@users.noreply.f.dev");
  });

  test("an agent keeps the address the forge invented for it", () => {
    expect(
      commitIdentity(
        {},
        {
          username: "scout",
          displayName: "",
          email: "scout@agents.invalid",
          kind: "agent",
          commitEmail: "noreply",
        },
      ),
    ).toEqual({ name: "scout", email: "scout@agents.invalid" });
  });
});

describe("commits the forge makes for a person", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let carol: User;
  let repo: Repo;
  let carols: Repo;
  let dir: string;

  const dirOf = (r: Repo) => repoDir(app.reposRoot, r.ownerName, r.name);
  const whoMade = (rev: string, r: Repo = repo): string =>
    Bun.spawnSync(["git", "log", "-1", "--format=%ae|%ce", rev], {
      cwd: dirOf(r),
    })
      .stdout.toString()
      .trim();

  const madeRepo = async (owner: User, name: string): Promise<Repo> => {
    const made = await createRepo(app, owner, { name, visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    await commitToBranch(app, owner, made.value, {
      branch: "main",
      message: "base",
      files: [{ path: "README.md", content: "hi\n" }],
    });
    return made.value;
  };

  const shipped = async (
    by: User,
    branch: string,
    strategy: "merge" | "squash",
    repo: Repo,
  ) => {
    const wrote = await commitToBranch(app, by, repo, {
      branch,
      base: "main",
      message: `work on ${branch}`,
      files: [{ path: `${branch}.txt`, content: branch }],
    });
    if (!wrote.ok) throw new Error(JSON.stringify(wrote.error));
    const opened = await openPull(app, by, repo, {
      title: branch,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const merged = await mergePull(app, by, repo, opened.value, strategy);
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    return { pull: opened.value, oid: merged.value.mergeOid };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-commit-identity-"));
    app = createApp({ dataDir, port: 0, host: "forge.example" });
    const a = await createUser(app.db, { trusted: true,
      username: "alice",
      email: "alice@private.test",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    const c = await createUser(app.db, { trusted: true,
      username: "carol",
      email: "carol@public.test",
      password: "a-good-passphrase",
    });
    if (!a.ok || !c.ok) throw new Error("users");
    alice = a.value;
    const opted = updateProfile(app, c.value, { commitEmail: "account" });
    if (!opted.ok) throw new Error(opted.error);
    carol = opted.value;
    repo = await madeRepo(alice, "app");
    carols = await madeRepo(carol, "notes");
    dir = dirOf(repo);
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a new account defaults to the no-reply address", () => {
    expect(alice.commitEmail).toBe("noreply");
    expect(getUserByName(app.db, "alice")?.commitEmail).toBe("noreply");
  });

  test("a merge by the default setting is authored and committed at the no-reply address", async () => {
    const { oid } = await shipped(alice, "feature", "merge", repo);
    expect(whoMade(oid)).toBe(
      "alice@users.noreply.forge.example|alice@users.noreply.forge.example",
    );
  });

  test("a squash and a revert carry it too", async () => {
    const { pull, oid } = await shipped(alice, "squashed", "squash", repo);
    expect(whoMade(oid)).toBe(
      "alice@users.noreply.forge.example|alice@users.noreply.forge.example",
    );
    const { getPull } = await import("../src/core/pulls.ts");
    const landed = getPull(app.db, repo.id, pull.number)!;
    const reverted = await revertPull(app, alice, repo, landed);
    if (!reverted.ok) throw new Error(JSON.stringify(reverted.error));
    expect(whoMade(`refs/heads/revert-${pull.number}`)).toBe(
      "alice@users.noreply.forge.example|alice@users.noreply.forge.example",
    );
  });

  test("a web edit, a new file and a delete by the default setting carry it", async () => {
    for (const files of [
      [{ path: "README.md", content: "edited\n" }],
      [{ path: "new.txt", content: "new\n" }],
      [{ path: "new.txt", content: null }],
    ]) {
      const edited = await editFiles(app, alice, repo, {
        branch: "main",
        message: "web edit",
        files,
      });
      if (!edited.ok) throw new Error(JSON.stringify(edited.error));
      expect(whoMade(edited.value.commit.commitOid)).toBe(
        "alice@users.noreply.forge.example|alice@users.noreply.forge.example",
      );
    }
  });

  test("a person who opted in gets their account email, on a merge and a web edit", async () => {
    const { oid } = await shipped(carol, "carols", "merge", carols);
    expect(whoMade(oid, carols)).toBe("carol@public.test|carol@public.test");
    const edited = await editFiles(app, carol, carols, {
      branch: "main",
      files: [{ path: "carol.txt", content: "c" }],
    });
    if (!edited.ok) throw new Error(JSON.stringify(edited.error));
    expect(whoMade(edited.value.commit.commitOid, carols)).toBe(
      "carol@public.test|carol@public.test",
    );
  });

  test("the private account email is in no git object at all", () => {
    const everything = Bun.spawnSync(
      ["git", "cat-file", "--batch-all-objects", "--batch"],
      { cwd: dir },
    ).stdout.toString();
    expect(everything).toContain("alice@users.noreply.forge.example");
    expect(everything).not.toContain("alice@private.test");
  });

  test("the setting refuses anything but its two values", () => {
    const bad = writeProfile(app.db, alice.id, {
      commitEmail: "everyone" as never,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe("invalid_commit_email");
    expect(getUserByName(app.db, "alice")?.commitEmail).toBe("noreply");
  });
});

describe("choosing the commit address", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie = "";

  const form = (fields: Record<string, string>) => new URLSearchParams(fields);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-commit-email-page-"));
    app = createApp({ dataDir, port: 0, host: "forge.example" });
    servers = await serve(app);
    base = servers.url;
    const res = await fetch(`${base}/signup`, {
      method: "POST",
      body: form({
        username: "dana",
        email: "dana@private.test",
        password: "a-good-passphrase",
      }),
      redirect: "manual",
    });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the settings page offers the no-reply address, selected", async () => {
    const page = await (
      await fetch(`${base}/settings`, { headers: { cookie } })
    ).text();
    expect(page).toContain('name="commitEmail"');
    expect(page).toMatch(
      /value="noreply"\s+selected\s*>\s*dana@users\.noreply\.forge\.example/,
    );
  });

  test("opting in is an explicit choice on the page, and opting out undoes it", async () => {
    const post = (commitEmail: string) =>
      fetch(`${base}/settings`, {
        method: "POST",
        headers: { cookie },
        body: form({
          displayName: "",
          email: "dana@private.test",
          commitEmail,
        }),
        redirect: "manual",
      });
    expect((await post("account")).status).toBe(303);
    expect(getUserByName(app.db, "dana")?.commitEmail).toBe("account");
    expect((await post("noreply")).status).toBe(303);
    expect(getUserByName(app.db, "dana")?.commitEmail).toBe("noreply");
    expect((await post("<script>")).status).toBe(422);
    expect(getUserByName(app.db, "dana")?.commitEmail).toBe("noreply");
  });

  test("a profile save without the field leaves the choice alone", async () => {
    writeProfile(app.db, getUserByName(app.db, "dana")!.id, {
      commitEmail: "account",
    });
    const res = await fetch(`${base}/settings`, {
      method: "POST",
      headers: { cookie },
      body: form({ displayName: "Dana", email: "dana@private.test" }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    expect(getUserByName(app.db, "dana")?.commitEmail).toBe("account");
    writeProfile(app.db, getUserByName(app.db, "dana")!.id, {
      commitEmail: "noreply",
    });
  });

  test("a cross-site form cannot flip it", async () => {
    const res = await fetch(`${base}/settings`, {
      method: "POST",
      headers: { cookie, origin: "https://evil.test" },
      body: form({ email: "dana@private.test", commitEmail: "account" }),
      redirect: "manual",
    });
    expect(res.status).toBe(403);
    expect(getUserByName(app.db, "dana")?.commitEmail).toBe("noreply");
  });

  test("the API names the choice, never the address, and validates it", async () => {
    const res = await fetch(`${base}/api/v1/user`, { headers: { cookie } });
    const me = (await res.json()) as { commitEmail?: string };
    expect(me.commitEmail).toBe("noreply");
    expect(JSON.stringify(me)).not.toContain("dana@private.test");
    const bad = await fetch(`${base}/api/v1/user`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", origin: base },
      body: JSON.stringify({ commitEmail: "everyone" }),
    });
    expect(bad.status).toBe(422);
    const good = await fetch(`${base}/api/v1/user`, {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", origin: base },
      body: JSON.stringify({ commitEmail: "account" }),
    });
    expect(good.status).toBe(200);
    expect(((await good.json()) as { commitEmail?: string }).commitEmail).toBe("account");
  });

  test("the public profile and the feed never carry the account email", async () => {
    for (const path of ["/dana", "/api/v1/users/dana"]) {
      const res = await fetch(`${base}${path}`);
      expect(await res.text()).not.toContain("dana@private.test");
    }
  });
});
