/**
 * Where a migrated repository came from (#3293): the record kept as data,
 * the address held to one rule, the chain a host reports, the one line the
 * header draws however the trail was built, and the backfill from the
 * migrations that happened before there was a record.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { listEvents } from "../src/core/events.ts";
import { showProvenance } from "../src/actions/provenance.ts";
import {
  cleanParents,
  getProvenance,
  provenanceUrl,
  recordProvenance,
  sourceLabel,
} from "../src/core/provenance.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import backfill from "../src/core/migrations/20261020180000-repo-provenance.ts";
import { lineageApiUrl, lineageFrom, lookupLineage } from "../src/origins/lineage.ts";
import { lineageLine } from "../src/web/chrome.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

describe("a source address", () => {
  test("is kept as a web link: no .git, no trailing slash, no query", () => {
    expect(provenanceUrl("https://github.com/Trevato/SO-ARM100.git")).toBe(
      "https://github.com/Trevato/SO-ARM100",
    );
    expect(provenanceUrl("https://code.example:8443/a/b/?x=1#y")).toBe(
      "https://code.example:8443/a/b",
    );
    expect(sourceLabel("https://github.com/Trevato/SO-ARM100")).toBe(
      "github.com/Trevato/SO-ARM100",
    );
  });

  test("anything that is not a plain http(s) link keeps nothing", () => {
    for (const raw of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "git://host/a/b",
      "https://user:secret@host/a/b",
      "https://host/",
      "not a url",
    ])
      expect(provenanceUrl(raw)).toBeUndefined();
  });

  test("a chain keeps names only, once each, without the source itself", () => {
    expect(
      cleanParents(
        ["b/arm", "B/ARM", "../x", "a/arm", null, "c/arm/extra", "root/arm"],
        "a/arm",
      ),
    ).toEqual(["b/arm", "root/arm"]);
  });
});

describe("what a host says the source forks", () => {
  test("GitHub is asked at its API host, a Forgejo at its own", () => {
    expect(lineageApiUrl("https://github.com/Trevato/SO-ARM100.git")).toBe(
      "https://api.github.com/repos/Trevato/SO-ARM100",
    );
    expect(lineageApiUrl("https://codeberg.org/a/b")).toBe(
      "https://codeberg.org/api/v1/repos/a/b",
    );
    // Not a repository's address: nothing is asked.
    expect(lineageApiUrl("https://gitlab.com/group/sub/b")).toBeUndefined();
    expect(lineageApiUrl("https://host/a/%2e%2e")).toBeUndefined();
  });

  test("GitHub's parent then its source; one that is the parent counts once", () => {
    expect(
      lineageFrom(
        {
          full_name: "Trevato/SO-ARM100",
          parent: { full_name: "mid/SO-ARM100" },
          source: { full_name: "TheRobotStudio/SO-ARM100" },
        },
        "Trevato/SO-ARM100",
      ),
    ).toEqual(["mid/SO-ARM100", "TheRobotStudio/SO-ARM100"]);
    expect(
      lineageFrom(
        {
          parent: { full_name: "TheRobotStudio/SO-ARM100" },
          source: { full_name: "TheRobotStudio/SO-ARM100" },
        },
        "Trevato/SO-ARM100",
      ),
    ).toEqual(["TheRobotStudio/SO-ARM100"]);
    expect(lineageFrom({ parent: { full_name: "<script>/x" } }, "")).toEqual([]);
  });

  test("asked once, anonymously; any refusal is no chain at all", async () => {
    const asked: string[] = [];
    const host = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        asked.push(`${url.pathname} ${request.headers.get("authorization") ?? ""}`);
        if (url.pathname === "/api/v1/repos/octo/arm")
          return Response.json({
            full_name: "octo/arm",
            parent: { full_name: "TheRobotStudio/arm" },
          });
        return new Response("Not Found", { status: 404 });
      },
    });
    try {
      const at = `http://127.0.0.1:${host.port}`;
      const options = { plain: true, allow: ["127.0.0.1"] };
      expect(await lookupLineage(`${at}/octo/arm.git`, options)).toEqual([
        "TheRobotStudio/arm",
      ]);
      expect(asked).toEqual(["/api/v1/repos/octo/arm "]);
      expect(await lookupLineage(`${at}/octo/gone`, options)).toEqual([]);
      // Without the test's leave, a loopback host is never asked.
      const before = asked.length;
      expect(await lookupLineage(`${at}/octo/arm`)).toEqual([]);
      expect(asked.length).toBe(before);
    } finally {
      host.stop(true);
    }
  });
});

describe("the record and the line", () => {
  let dir: string;
  let app: App;
  let owner: User;
  let other: User;
  let source: Repo;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-provenance-"));
    app = createApp({ dataDir: dir, port: 0 });
    const person = async (username: string): Promise<User> => {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.test`,
        adminIfFirst: true,
      });
      if (!made.ok) throw new Error(String(made.error));
      promote(app.db, made.value);
      return made.value;
    };
    owner = await person("trevato");
    other = await person("someone");
    const made = await createRepo(app, owner, { name: "arm", visibility: "public" });
    if (!made.ok) throw new Error(made.error);
    source = made.value;
  });

  afterAll(async () => {
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("a fork made here of a migrated repository reads as one line", () => {
    recordProvenance(app.db, source.id, {
      url: "https://github.com/Trevato/SO-ARM100.git",
      parents: ["TheRobotStudio/SO-ARM100"],
    });
    const fork = { ...source, id: "not-recorded", ownerName: "someone" };
    const line = lineageLine(app.db, fork, source)!.text.replace(/\s+/g, " ");
    expect(line).toMatch(/forked from <a href="\/trevato\/arm" ?>trevato\/arm<\/a ?> · migrated/);
    expect(line).toContain(
      'migrated from <a href="https://github.com/Trevato/SO-ARM100" rel="noopener noreferrer">github.com/Trevato/SO-ARM100</a>',
    );
    expect(line).toContain(
      'fork of <a href="https://github.com/TheRobotStudio/SO-ARM100" rel="noopener noreferrer">TheRobotStudio/SO-ARM100</a>',
    );
    // A repository with neither a parent nor a record draws nothing.
    expect(lineageLine(app.db, fork, undefined)).toBeNull();
  });

  test("hidden is hidden everywhere it is drawn; the record stays", () => {
    // Someone who can read it cannot hide it.
    expect(showProvenance(app, other, source, false)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(getProvenance(app.db, source.id)?.shown).toBe(true);
    // A plan changes nothing; the real thing does.
    expect(showProvenance(app, owner, source, false, true)).toEqual({
      ok: true,
      value: { shown: false, was: true, dryRun: true },
    });
    expect(getProvenance(app.db, source.id)?.shown).toBe(true);
    expect(showProvenance(app, owner, source, false)).toEqual({
      ok: true,
      value: { shown: false, was: true, dryRun: false },
    });
    // The settings trail says from what to what, in the one shape every writer uses.
    const trail = listEvents(app.db, { repoId: source.id, kind: "repo.settings_updated", limit: 1 })[0]!;
    expect(trail.actorId).toBe(owner.id);
    expect(trail.payload["changed"]).toEqual({ provenance: { from: true, to: false } });
    expect(lineageLine(app.db, source, undefined)).toBeNull();
    expect(getProvenance(app.db, source.id)?.parents).toEqual([
      "TheRobotStudio/SO-ARM100",
    ]);
    // A second record keeps the owner's switch where it was.
    recordProvenance(app.db, source.id, {
      url: "https://github.com/Trevato/SO-ARM100",
      parents: [],
    });
    expect(getProvenance(app.db, source.id)?.shown).toBe(false);
  });

  test("the backfill reads a migration's push event; an origin's bare name keeps nothing", async () => {
    const made = async (name: string): Promise<Repo> => {
      const r = await createRepo(app, owner, { name });
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    const pasted = await made("pasted");
    const picked = await made("picked");
    const pushed = await made("pushed");
    const event = app.db.query(
      "INSERT INTO event (id, kind, repo_id, payload, created_at) VALUES (?1, 'push', ?2, ?3, '2026-10-01T00:00:00.000Z')",
    );
    event.run("e1", pasted.id, JSON.stringify({ via: "migrate", from: "https://github.com/Trevato/SO-ARM100.git" }));
    event.run("e2", picked.id, JSON.stringify({ via: "migrate", from: "octo/arm" }));
    event.run("e3", pushed.id, JSON.stringify({ updates: [], from: "https://x.example/a/b" }));
    app.db.exec(backfill);
    expect(getProvenance(app.db, pasted.id)).toMatchObject({
      sourceUrl: "https://github.com/Trevato/SO-ARM100",
      parents: [],
      shown: true,
      migratedAt: "2026-10-01T00:00:00.000Z",
    });
    expect(getProvenance(app.db, picked.id)).toBeUndefined();
    expect(getProvenance(app.db, pushed.id)).toBeUndefined();
  });
});
