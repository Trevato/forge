/**
 * A mirror's repo page names its upstream, its licence and its original
 * authors in one line; a fork of the mirror says the same through its
 * lineage; a native repo says nothing; every value is escaped (#10531).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AUTHOR_WINDOW, clearCreditCache, creditOf, creditText, licenceName, topAuthors, type CreditSource } from "../src/core/credit.ts";
import { runGit } from "../src/git/env.ts";
import { createOrigin, linkRepoToOrigin } from "../src/core/origins.ts";
import { createRepo, forkRepo, getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const MIT = "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n";

describe("the credit line of a mirror", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let mirror: Repo;
  let fork: Repo;
  let bare: Repo;
  let plain: Repo;
  let frozen: Repo;
  let orphan: Repo;

  const put = async (repo: Repo, who: string, files: { path: string; content: string }[]) => {
    const r = await commitFiles(repoDir(app.reposRoot, repo.ownerName, repo.name), {
      branch: "main",
      message: "work",
      files,
      author: { name: who, email: "a@x.test" },
    });
    expect(r.ok).toBe(true);
  };
  const page = async (repo: Repo) =>
    await (await fetch(`${servers.url}/${repo.ownerName}/${repo.name}`)).text();
  const line = (body: string) => /<p class="small muted">\s*(?:Mirrored|Forked) from[\s\S]*?<\/p>/.exec(body)?.[0] ?? "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-credit-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    const made0 = await createUser(app.db, { origin: "seed", trusted: true, username: "ada", email: "ada@forge.test", adminIfFirst: true });
    if (!made0.ok) throw new Error(String(made0.error));
    const u = made0.value;
    const mk = async (name: string) => {
      const r = await createRepo(app.db, app.reposRoot, { ownerId: u.id, name, visibility: "public", description: "", defaultBranch: "main" });
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    mirror = await mk("lib");
    bare = await mk("bare");
    plain = await mk("plain");
    frozen = await mk("frozen");
    const hidden = await mk("hidden");
    await put(mirror, "Zed & Zeta", [{ path: "LICENSE", content: MIT }, { path: "a.txt", content: "1\n" }]);
    await put(mirror, "Zed & Zeta", [{ path: "b.txt", content: "2\n" }]);
    await put(mirror, "Quinn", [{ path: "c.txt", content: "3\n" }]);
    await put(bare, "Quinn", [{ path: "a.txt", content: "1\n" }]);
    await put(frozen, "Quinn", [{ path: "a.txt", content: "1\n" }]);
    await put(hidden, "Quinn", [{ path: "a.txt", content: "1\n" }]);
    await put(plain, "Quinn", [{ path: "a.txt", content: "1\n" }]);
    const made = createOrigin(app.db, dataDir, { userId: u.id, kind: "forgejo", apiUrl: "https://up.example/api/v1", webUrl: "https://up.example", login: "up", token: "t0ken-t0ken" });
    if (!made.ok) throw new Error(made.error);
    const origin = made.value;
    for (const [repo, remote] of [[mirror, "lib"], [bare, "bare"]] as const)
      linkRepoToOrigin(app.db, repo.id, { originId: origin.id, fullName: `up/${remote}`, remoteId: remote, htmlUrl: `https://up.example/up/${remote}` });
    linkRepoToOrigin(app.db, hidden.id, { originId: origin.id, fullName: "up/hidden", remoteId: "hidden", htmlUrl: "https://up.example/up/hidden" });
    // Frozen: the origin went, the provenance stayed; its page is not a web address.
    app.db.run(
      "UPDATE repo SET origin_id = NULL, origin_full_name = 'up/frozen', origin_html_url = 'javascript:alert(1)' WHERE id = ?1",
      [frozen.id],
    );
    const hiddenFork = await forkRepo(app.db, app.reposRoot, hidden, u.id, "hidden-fork");
    if (!hiddenFork.ok) throw new Error(hiddenFork.error);
    orphan = hiddenFork.value;
    app.db.run("UPDATE repo SET visibility = 'private' WHERE id = ?1", [hidden.id]);
    app.db.run("UPDATE repo SET visibility = 'public' WHERE id = ?1", [orphan.id]);
    const forked = await forkRepo(app.db, app.reposRoot, mirror, u.id, "lib-mine");
    if (!forked.ok) throw new Error(forked.error);
    fork = forked.value;
    servers = await serve(app);
  });

  afterAll(async () => {
    await servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });

  test("a mirror names its upstream, its licence and its top authors, escaped", async () => {
    const credit = line(await page(mirror));
    expect(credit).toContain('href="https://up.example/up/lib"');
    expect(credit).toContain("up/lib");
    expect(credit).toContain("MIT");
    expect(credit).toContain("Zed &amp; Zeta, Quinn");
    expect(credit).not.toContain(" & ");
  });

  test("a fork of the mirror shows the same credit through its lineage", async () => {
    const credit = line(await page(fork));
    expect(credit).toContain("up/lib");
    expect(credit).toContain("MIT");
    expect(credit).toContain("Zed &amp; Zeta");
  });

  test("a mirror without a licence file says so; a native repo shows no line", async () => {
    expect(line(await page(bare))).toContain("no licence file");
    expect(line(await page(plain))).toBe("");
  });

  test("licence text is named, and an unknown one keeps its file name", () => {
    expect(licenceName("Apache License\nVersion 2.0, January 2004", "LICENSE")).toBe("Apache-2.0");
    expect(licenceName("do what you like", "COPYING")).toBe("COPYING");
  });

  test("a detached mirror still names its frozen origin, and a non-web address is text, not a link", async () => {
    const credit = line(await page(frozen));
    expect(credit).toContain("Mirrored from");
    expect(credit).toContain("up/frozen");
    expect(credit).not.toContain("<a ");
    expect(credit).not.toContain("javascript:");
  });

  test("a fork whose mirrored parent the viewer cannot read shows no line", async () => {
    expect(line(await page(orphan))).toBe("");
  });

  test("a fork says so in a sentence", async () => {
    expect(line(await page(fork))).toContain("Forked from a mirror of");
    expect(line(await page(mirror))).toMatch(/Mirrored from\s+<a [^>]*>up\/lib<\/a> · MIT · by /);
  });

  test("authors come from a tag and from a bare commit id, not only a branch", async () => {
    const dir = repoDir(app.reposRoot, mirror.ownerName, mirror.name);
    const sha = await runGit(["rev-parse", "main"], { cwd: dir });
    if (!sha.ok) throw new Error("rev-parse");
    const tagged = await runGit(["tag", "v1", sha.value], { cwd: dir });
    expect(tagged.ok).toBe(true);
    const source: CreditSource = { tree: async () => ({ ok: false }), blob: async () => ({ ok: false }) };
    for (const ref of ["v1", sha.value]) {
      const credit = await creditOf(app.db, app.reposRoot, getRepoById(app.db, mirror.id)!, undefined, source, ref);
      expect(creditText(credit!)).toContain("by Zed & Zeta, Quinn");
    }
  });

  test("authors count only the newest commits and a git that cannot answer costs the authors, not the page", async () => {
    clearCreditCache();
    const dir = repoDir(app.reposRoot, mirror.ownerName, mirror.name);
    expect(AUTHOR_WINDOW).toBeGreaterThan(0);
    // Newest first: Quinn, then two by Zed & Zeta. A window of one sees only Quinn.
    expect(await topAuthors(dir, "main", { window: 1 })).toEqual(["Quinn"]);
    // A miss (no such directory) is empty, fast, and not kept: the real answer still comes.
    expect(await topAuthors(join(dataDir, "nowhere"), "main")).toEqual([]);
    expect((await topAuthors(dir, "main"))[0]).toBe("Zed & Zeta");
  });
});
