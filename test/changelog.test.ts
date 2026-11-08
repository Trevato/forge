import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { candidates, forgetLive, type Landing, type Landings } from "../src/release/landings.ts";
import { expectWork, requestStatements } from "./helpers/work.ts";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe("changelog page", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let token: string;
  const oids: string[] = [];
  const kept = { commit: process.env["FORGE_COMMIT"], repo: process.env["FORGE_REPO"] };

  /** A pull merged at `at` whose merge commit is `oid`, in the repository `repoName`. */
  let n = 0;
  const merge = (repoName: string, title: string, at: string, oid: string, visibility = "public") => {
    const repoId = app.db.query<{ id: string }, [string]>("SELECT id FROM repo WHERE name = ?1").get(repoName)!.id;
    const issueId = `i${++n}`;
    app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', ?4, '', ?5, 'closed', ?6)`).run(issueId, repoId, n, title, alice.id, at);
    app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at, merged_oid) VALUES (?1, 'main', ?2, '', '', ?3, ?4, ?5)`).run(issueId, `b/${n}`, repoId, at, oid);
    if (visibility !== "public") app.db.run("UPDATE repo SET visibility = ?1 WHERE name = ?2", [visibility, repoName]);
  };

  const mcp = async (args: Record<string, unknown>) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "releases", arguments: args } }),
    });
    const body = (await res.json()) as { result: { content: { text: string }[] } };
    return JSON.parse(body.result.content[0]!.text) as Record<string, any>;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-changelog-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    alice = must(
      await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@f.dev", password: "a-good-passphrase", adminIfFirst: true }),
    );
    const repo = must(await createRepo(app, alice, { name: "forge", visibility: "public" }));
    must(await createRepo(app, alice, { name: "notes", visibility: "public" }));
    for (let i = 1; i <= 3; i++) {
      const c = must(await commitToBranch(app, alice, repo, { message: `work ${i}`, files: [{ path: `f${i}.txt`, content: `${i}\n` }] }));
      oids.push(c.commitOid);
    }
    app.config.forgeRepo = "alice/forge";
    // The running commit is the second: the third has landed and is not yet live.
    process.env["FORGE_COMMIT"] = oids[1]!;
    process.env["FORGE_VERSION"] = "1.2.3";
    const day = new Date().toISOString().slice(0, 10);
    merge("forge", "First <b>thing</b>", `${day}T01:00:00.000Z`, oids[0]!);
    merge("forge", "Second thing", `${day}T02:00:00.000Z`, oids[1]!);
    merge("forge", "Third thing", `${day}T03:00:00.000Z`, oids[2]!);
    merge("notes", "A note app change", `${day}T02:30:00.000Z`, "");
    token = createToken(app.db, alice.id, "rw", "rw").token;
  }, 60_000);

  afterAll(async () => {
    for (const [k, v] of [["FORGE_COMMIT", kept.commit]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env["FORGE_VERSION"];
    forgetLive();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("lists what the running commit contains, newest first, and sets the rest apart as on its way", async () => {
    const res = await fetch(`${servers.url}/changelog`);
    expect(res.status).toBe(200);
    expect(res.headers.get("server-timing")).toContain("releases");
    const body = await res.text();
    const at = (s: string) => body.indexOf(s);
    expect(at("Second thing")).toBeGreaterThan(-1);
    expect(at("Second thing")).toBeLessThan(at("First &lt;b&gt;thing&lt;/b&gt;"));
    expect(body).not.toContain("<b>thing</b>");
    expect(body).toContain('href="/alice/forge/pulls/2"');
    expect(body).toContain("1.2.3");
    expect(body).toContain("2 shipped today");
    // Third is on its way: after the "On its way" heading and before the live days.
    expect(at("On its way")).toBeLessThan(at("Third thing"));
    expect(at("Third thing")).toBeLessThan(at("Second thing"));
    expect(body).toContain('data-live="pull.merged,app.serving"');
    // This forge leads; the other repository is a filter.
    expect(body).not.toContain("A note app change");
  });

  test("another repository is one filter away, and an unknown one falls back to this forge", async () => {
    const all = await (await fetch(`${servers.url}/changelog?repo=all`)).text();
    expect(all).toContain("A note app change");
    expect(all).toContain("alice/notes");
    const one = await (await fetch(`${servers.url}/changelog?repo=alice/notes`)).text();
    expect(one).toContain("A note app change");
    expect(one).not.toContain("Second thing");
    const bogus = await (await fetch(`${servers.url}/changelog?repo=%3Cscript%3E`)).text();
    expect(bogus).toContain("Second thing");
    expect(bogus).not.toContain("<script>");
  });

  test("a private repository's pulls are never listed", async () => {
    app.db.run("UPDATE repo SET visibility = 'private' WHERE name = 'notes'");
    try {
      const body = await (await fetch(`${servers.url}/changelog?repo=all`)).text();
      expect(body).not.toContain("A note app change");
    } finally {
      app.db.run("UPDATE repo SET visibility = 'public' WHERE name = 'notes'");
    }
  });

  test("the same list is the MCP's, for a reader with a token", async () => {
    const got = await mcp({ shipped: true, repo: "all" });
    expect(got["version"]).toBe("1.2.3");
    expect(got["commit"]).toBe(oids[1]);
    expect(got["live"].map((l: { title: string }) => l.title)).toEqual(["A note app change", "Second thing", "First <b>thing</b>"]);
    expect(got["onItsWay"].map((l: { title: string }) => l.title)).toEqual(["Third thing"]);
  });

  test("with no FORGE_REPO the repository holding the running commit is the forge's own", async () => {
    delete app.config.forgeRepo;
    forgetLive();
    try {
      const body = await (await fetch(`${servers.url}/changelog`)).text();
      expect(body.indexOf("On its way")).toBeLessThan(body.indexOf("Third thing"));
      expect(body.indexOf("Third thing")).toBeLessThan(body.indexOf("Second thing"));
      expect(body).not.toContain("A note app change");
      const got = await mcp({ shipped: true });
      expect(got["onItsWay"].map((l: { title: string }) => l.title)).toEqual(["Third thing"]);
      // Production serves the third commit: it moves to live.
      process.env["FORGE_COMMIT"] = oids[2]!;
      const later = await mcp({ shipped: true });
      expect(later["onItsWay"]).toEqual([]);
      expect(later["live"].map((l: { title: string }) => l.title)).toContain("Third thing");
    } finally {
      process.env["FORGE_COMMIT"] = oids[1]!;
      app.config.forgeRepo = "alice/forge";
      forgetLive();
    }
  });

  test("a private repository holding the running commit is never the forge's own", async () => {
    delete app.config.forgeRepo;
    forgetLive();
    app.db.run("UPDATE repo SET visibility = 'private' WHERE name = 'forge'");
    process.env["FORGE_COMMIT"] = oids[0]!;
    try {
      const body = await (await fetch(`${servers.url}/changelog`)).text();
      expect(body).not.toContain("Second thing");
    } finally {
      app.db.run("UPDATE repo SET visibility = 'public' WHERE name = 'forge'");
      process.env["FORGE_COMMIT"] = oids[1]!;
      app.config.forgeRepo = "alice/forge";
      forgetLive();
    }
  });

  test("with several public repositories, the one holding the running commit is the forge's own", async () => {
    const fork = must(await createRepo(app, alice, { name: "fork", visibility: "public" }));
    const c = must(await commitToBranch(app, alice, fork, { message: "fork work", files: [{ path: "x.txt", content: "x\n" }] }));
    const day = new Date().toISOString().slice(0, 10);
    merge("fork", "Fork change", `${day}T23:00:00.000Z`, c.commitOid);
    delete app.config.forgeRepo;
    forgetLive();
    process.env["FORGE_COMMIT"] = c.commitOid;
    try {
      const body = await (await fetch(`${servers.url}/changelog`)).text();
      expect(body).toContain("Fork change");
      expect(body).not.toContain("Second thing");
    } finally {
      process.env["FORGE_COMMIT"] = oids[1]!;
      app.config.forgeRepo = "alice/forge";
      forgetLive();
    }
  });

  test("when a fork holds the running commit too, the repository with the most merged pulls wins", async () => {
    // The fork takes the forge's history; its own pull is the newest merged.
    const fetched = await runGit(["fetch", "-q", repoDir(app.reposRoot, "alice", "forge"), "+refs/heads/main:refs/heads/upstream"], {
      cwd: repoDir(app.reposRoot, "alice", "fork"),
    });
    expect(fetched.ok).toBe(true);
    delete app.config.forgeRepo;
    forgetLive();
    try {
      const body = await (await fetch(`${servers.url}/changelog`)).text();
      expect(body.indexOf("On its way")).toBeLessThan(body.indexOf("Third thing"));
      expect(body).not.toContain("Fork change");
    } finally {
      app.config.forgeRepo = "alice/forge";
      app.db.run("DELETE FROM issue WHERE title = 'Fork change'");
      forgetLive();
    }
  });

  test("a miss with no merged pulls yet is not remembered", async () => {
    delete app.config.forgeRepo;
    forgetLive();
    app.db.run("UPDATE repo SET visibility = 'private'");
    try {
      expect(await (await fetch(`${servers.url}/changelog`)).text()).toContain("Nothing has shipped yet");
      app.db.run("UPDATE repo SET visibility = 'public'");
      const body = await (await fetch(`${servers.url}/changelog`)).text();
      expect(body.indexOf("On its way")).toBeLessThan(body.indexOf("Third thing"));
    } finally {
      app.db.run("UPDATE repo SET visibility = 'public'");
      app.config.forgeRepo = "alice/forge";
      forgetLive();
    }
  });

  test("candidates: most merged pulls first, then by name", () => {
    const r = (repo: string) => ({ repo, number: 1, title: "", at: "", oid: "" });
    expect(candidates([r("b/fork"), r("a/forge"), r("a/forge"), r("c/x"), r("a/y")])).toEqual(["a/forge", "a/y", "b/fork", "c/x"]);
  });

  test("the footer links to it", async () => {
    const body = await (await fetch(`${servers.url}/changelog`)).text();
    expect(body).toContain('href="/changelog"');
  });

  test("warm, the page answers with its days already drawn, for no more work than cold (#9688)", async () => {
    const url = `${servers.url}/changelog`;
    const cold = await requestStatements(app.db, url);
    const warmStatements = await requestStatements(app.db, url);
    expectWork(warmStatements, { max: cold });
    const res = await fetch(url);
    expect(res.headers.get("server-timing")).toContain("render");
    const { Window } = await import("happy-dom");
    const doc = new Window().document;
    doc.body.innerHTML = await res.text();
    // No script ran: the days, their headings and their rows are in the markup the server sent.
    doc.querySelectorAll("script").forEach((s) => s.remove());
    const days = [...doc.querySelectorAll("#shipped section[data-day]")];
    expect(days.length).toBe(1);
    expect(days[0]!.querySelector("h2 time")!.getAttribute("datetime")).toBe(new Date().toISOString().slice(0, 10));
    expect([...days[0]!.querySelectorAll("li .row-title")].map((t) => t.textContent)).toEqual(["Second thing", "First <b>thing</b>"]);
    expect(doc.getElementById("shipped-today")!.textContent).toBe("2 shipped today (UTC).");
  });

  test("empty only when nothing has shipped", async () => {
    app.db.run("UPDATE pull SET merged_at = NULL");
    const body = await (await fetch(`${servers.url}/changelog`)).text();
    expect(body).toContain("Nothing has shipped yet");
  });
});

describe("changelog days follow a time zone", () => {
  const landing = (at: string) => ({ repo: "a/forge", number: 1, title: "Late merge", at, commit: "" }) as any;
  const read = (at: string) => ({ live: [landing(at)], onItsWay: [], version: "1", commit: null, own: "a/forge" }) as any;
  // 6:30 pm on 1 Nov in Chicago (UTC-5 after the clocks went back) is already 2 Nov in UTC.
  const at = "2026-11-01T23:30:00.000Z";
  const now = new Date("2026-11-02T00:10:00.000Z");

  test("a merge late in the day west of UTC is today there, and the next day in UTC", async () => {
    const { shippedRegion } = await import("../src/web/pages/changelog.ts");
    const west = String(shippedRegion(read(at), "all", now, "America/Chicago"));
    expect(west).toContain(">Today<");
    expect(west).toContain('data-day="2026-11-01"');
    expect(west).toContain("1 shipped today.");
    expect(west).not.toContain("(UTC)");
    expect(west).not.toContain("· UTC");
    const utc = String(shippedRegion(read(at), "all", new Date("2026-11-02T10:00:00.000Z")));
    expect(utc).toContain(">Yesterday<");
    expect(utc).toContain("(UTC)");
    expect(utc).toContain("data-zone");
  });

  test("headings read Today, Yesterday, then a date", async () => {
    const { dayHeading, dayOf, daysJs } = await import("../src/release/days.ts");
    expect(dayHeading("2026-11-02", "2026-11-02")).toBe("Today");
    expect(dayHeading("2026-11-01", "2026-11-02")).toBe("Yesterday");
    expect(dayHeading("2026-10-30", "2026-11-02")).toBe("Fri 30 Oct");
    expect(dayHeading("2025-12-31", "2026-01-01")).toBe("Yesterday");
    expect(dayHeading("2025-12-30", "2026-01-01")).toBe("Tue 30 Dec 2025");
    expect(dayOf(at, "America/Chicago")).toBe("2026-11-01");
    expect(dayOf(at, "UTC")).toBe("2026-11-01");
    expect(dayOf("2026-11-02T01:30:00Z", "America/Chicago")).toBe("2026-11-01");
    expect(dayOf("2026-11-02T01:30:00Z", "UTC")).toBe("2026-11-02");
    // The source sent to the browser answers the same.
    const shipped = new Function(`${daysJs}; return { dayOf, dayHeading };`)();
    expect(shipped.dayHeading("2026-10-30", "2026-11-02")).toBe("Fri 30 Oct");
    expect(shipped.dayOf("2026-11-02T01:30:00Z")).toMatch(/^2026-11-0[12]$/);
  });
});

describe("the browser regroups the changelog into the reader's days", () => {
  const rows = [
    { repo: "a/forge", number: 3, title: "Three", at: "2026-11-03T02:00:00.000Z", commit: "" },
    { repo: "a/forge", number: 2, title: "Two", at: "2026-11-02T20:00:00.000Z", commit: "" },
    { repo: "a/forge", number: 1, title: "One", at: "2026-11-02T01:30:00.000Z", commit: "" },
  ] as any[];
  const read = { live: rows, onItsWay: [], version: "1", commit: null, own: "a/forge" } as any;
  const server = async () => {
    const { shippedRegion } = await import("../src/web/pages/changelog.ts");
    return `<div id="shipped">${String(shippedRegion(read, "all", new Date("2026-11-03T03:00:00.000Z")))}</div>`;
  };
  const titles = (card: any) => [...(card.querySelectorAll(".row-title") as any[])].map((e: any) => e.textContent);
  let zone: string | undefined;
  afterEach(() => {
    setSystemTime();
    if (zone === undefined) delete process.env["TZ"];
    else process.env["TZ"] = zone;
  });

  test("west of UTC rows move between cards, headings read Today and Yesterday, counts and the UTC marks follow", async () => {
    const { Window } = await import("happy-dom");
    const { localDaysJs } = await import("../src/web/pages/changelog.ts");
    zone = process.env["TZ"];
    process.env["TZ"] = "America/Chicago";
    setSystemTime(new Date("2026-11-03T03:00:00.000Z")); // 9 pm on 2 Nov in Chicago
    const window = new Window();
    const doc = window.document as any;
    doc.body.innerHTML = await server();
    // What the server drew: UTC days, one of them emptied below, and the UTC marks.
    expect(doc.querySelectorAll("[data-day]").length).toBe(2);
    expect(doc.getElementById("shipped-today")!.textContent).toBe("1 shipped today (UTC).");
    expect(doc.querySelectorAll("[data-zone]").length).toBe(2);
    new Function("document", localDaysJs)(doc);
    const cards = [...doc.querySelectorAll("[data-day]")];
    expect(cards.map((c) => c.getAttribute("data-day"))).toEqual(["2026-11-02", "2026-11-01"]);
    expect(cards.map((c) => c.querySelector("h2 time")!.textContent)).toEqual(["Today", "Yesterday"]);
    expect(cards.map(titles)).toEqual([["Three", "Two"], ["One"]]);
    expect(cards.map((c) => c.querySelector(".badge")!.textContent)).toEqual(["2", "1"]);
    expect(doc.getElementById("shipped-today")!.textContent).toBe("2 shipped today.");
    expect(doc.querySelectorAll("[data-zone]").length).toBe(0);
    expect(doc.body.textContent).not.toContain("UTC");

    // A swap puts the server's UTC cards back; the client regroups them again.
    doc.getElementById("shipped")!.innerHTML = (await server()).replace(/^<div id="shipped">|<\/div>$/g, "");
    expect(doc.querySelectorAll("[data-day]").length).toBe(2);
    doc.dispatchEvent(new window.Event("forge:swapped") as unknown as Event);
    expect([...doc.querySelectorAll("[data-day]")].map(titles)).toEqual([["Three", "Two"], ["One"]]);
    expect(doc.getElementById("shipped-today")!.textContent).toBe("2 shipped today.");
    await window.happyDOM.close();
  });

  test("with no cards and an empty #shipped-today the script leaves the span empty; with text or cards it writes the count", async () => {
    const { Window } = await import("happy-dom");
    const { localDaysJs } = await import("../src/web/pages/changelog.ts");
    const run = (inner: string) => {
      const window = new Window();
      const doc = window.document as any;
      doc.body.innerHTML = `<div id="shipped">${inner}</div>`;
      new Function("document", localDaysJs)(doc);
      const text = doc.getElementById("shipped-today")!.textContent;
      void window.happyDOM.close();
      return text;
    };
    expect(run('<p><span id="shipped-today"></span></p>')).toBe("");
    expect(run('<p><span id="shipped-today">Nothing shipped today (UTC).</span></p>')).toBe("Nothing shipped today.");
  });
});

describe("the top line names what is running", () => {
  test("nothing ever shipped: the shipped-today sentence is left out, its id stays", async () => {
    const { shippedRegion } = await import("../src/web/pages/changelog.ts");
    const out = String(shippedRegion({ live: [], onItsWay: [], version: "dev", commit: null, own: "a/forge" } as any, "all"));
    expect(out).toContain('<span id="shipped-today"></span>');
    expect(out).not.toContain("Nothing shipped today");
    expect(out).toContain("Nothing has shipped yet");
  });

  test("shipped before today: the sentence still says nothing shipped today", async () => {
    const { shippedRegion } = await import("../src/web/pages/changelog.ts");
    const old = { repo: "a/forge", title: "Old", at: "2026-10-01T00:00:00.000Z", number: 1, sha: "a".repeat(40) };
    const out = String(shippedRegion({ live: [old], onItsWay: [], version: "dev", commit: null, own: "a/forge" } as any, "all", new Date("2026-11-02T12:00:00Z")));
    expect(out).toContain("Nothing shipped today (UTC).");
  });

  const top = async (version: string, commit: string | null) => {
    const { shippedRegion } = await import("../src/web/pages/changelog.ts");
    const read = { live: [], onItsWay: [], version, commit, own: "a/forge" } as any;
    return String(shippedRegion(read, "all")).match(/id="shipped-top">([\s\S]*?)<span id="shipped-today"/)![1]!;
  };

  test("a development build with a commit reads the short sha and no dev", async () => {
    const line = await top("dev", "8a16183d0000000000000000000000000000abcd");
    expect(line).toContain("8a16183");
    expect(line).not.toContain("dev");
  });

  test("a development build with no commit says so", async () => {
    expect(await top("dev", null)).toContain("Live: a development build.");
  });

  test("a release keeps version and sha", async () => {
    const line = await top("1.2.3", "8a16183d0000000000000000000000000000abcd");
    expect(line).toContain("1.2.3 · ");
    expect(line).toContain("8a16183");
  });

  test("the short sha links to the commit in the forge's own repository, escaped", async () => {
    const { shippedRegion } = await import("../src/web/pages/changelog.ts");
    const oid = "8a16183d0000000000000000000000000000abcd";
    const out = String(shippedRegion({ live: [], onItsWay: [], version: "dev", commit: oid, own: "a/forge" } as any, "all"));
    expect(out).toContain(`<a class="sha" href="/a/forge/commit/${oid}"`);
    const odd = String(shippedRegion({ live: [], onItsWay: [], version: "dev", commit: oid, own: 'a/"><b>' } as any, "all"));
    expect(odd).not.toContain("<b>");
    expect(odd).toContain("&quot;");
  });

  test("no link when the reader cannot open the repository, or there is none", async () => {
    const { shippedRegion } = await import("../src/web/pages/changelog.ts");
    const oid = "8a16183d0000000000000000000000000000abcd";
    const base = { live: [], onItsWay: [], version: "dev", commit: oid, own: "a/forge" } as any;
    const hidden = String(shippedRegion(base, "all", new Date(), "UTC", undefined, false));
    expect(hidden).toContain('<span class="sha">8a16183</span>');
    expect(hidden).not.toContain("/commit/");
    expect(String(shippedRegion({ ...base, own: undefined }, "all"))).not.toContain("/commit/");
  });
});

describe("changelog rows, not boxes (#9688)", () => {
  const landing = (number: number, at: string, bet?: string): Landing => ({ repo: "a/forge", number, title: `T${number}`, at, live: true, ...(bet === undefined ? {} : { bet }) });
  const landings = (live: Landing[], onItsWay: Landing[] = []): Landings => ({ live, onItsWay, version: "1", commit: null, own: "a/forge" });
  const sample = landings([landing(2, "2026-11-02T01:00:00.000Z"), landing(1, "2026-11-01T01:00:00.000Z", "Speed")], [landing(3, "2026-11-02T02:00:00.000Z")]);
  const parse = async (markup: string) => {
    const { Window } = await import("happy-dom");
    const doc = new Window().document;
    doc.body.innerHTML = markup;
    return doc;
  };

  test("each day is a section with an h2 over a list, and nothing is a card", async () => {
    const { shippedRegion } = await import("../src/web/pages/changelog.ts");
    const doc = await parse(String(shippedRegion(sample, "all", new Date("2026-11-02T10:00:00.000Z"))));
    expect(doc.querySelectorAll(".card, .card-head").length).toBe(0);
    const days = [...doc.querySelectorAll("section[data-day]")];
    expect(days.map((d) => d.getAttribute("data-day"))).toEqual(["2026-11-02", "2026-11-01"]);
    for (const d of days) {
      // The heading, then the list, and nothing else.
      expect([...d.children].map((c) => `${c.tagName}.${c.className}`)).toEqual(["H2.", "UL.list setting-list"]);
    }
    // On its way is the same shape: a heading over the same list.
    const way = [...doc.querySelectorAll("h2")].find((h) => h.textContent === "On its way")!;
    expect(way.nextElementSibling!.className).toBe("list setting-list");
  });

  test("each heading holds what localDaysJs reads, in its order: the day, the UTC mark, then the one count badge", async () => {
    const { shippedRegion, localDaysJs } = await import("../src/web/pages/changelog.ts");
    const doc = await parse(String(shippedRegion(sample, "all", new Date("2026-11-02T10:00:00.000Z"))));
    const heads = [...doc.querySelectorAll("section[data-day] > h2")];
    expect(heads.length).toBe(2);
    const shape = heads.map((h) => [...h.children].map((c) => (c.tagName === "TIME" ? `time ${c.getAttribute("datetime")}` : c.hasAttribute("data-zone") ? `zone ${c.textContent}` : `${c.className} ${c.textContent}`)));
    expect(shape).toEqual([
      ["time 2026-11-02", "zone UTC", "badge 1"],
      ["time 2026-11-01", "zone UTC", "badge 1"],
    ]);
    // The script's first .badge in a section, once the zone mark is gone, is the count: a row's bet badge sits under the list.
    for (const h of heads) {
      h.querySelector("[data-zone]")!.remove();
      expect(h.parentElement!.querySelector(".badge")!.textContent).toBe("1");
    }
    // In the reader's own zone there is no mark at all.
    const local = await parse(String(shippedRegion(sample, "all", new Date("2026-11-02T10:00:00.000Z"), "America/Chicago")));
    expect(local.querySelectorAll("[data-zone]").length).toBe(0);
    for (const sel of ["[data-day]", "h2 time", "[data-zone]", ".badge"]) expect(localDaysJs).toContain(`'${sel}'`);
    expect(localDaysJs.indexOf("[data-zone]")).toBeLessThan(localDaysJs.indexOf("c.querySelector('.badge')"));
  });

  test("nothing shipped is one quiet line, the board's own", async () => {
    const { shippedRegion } = await import("../src/web/pages/changelog.ts");
    const doc = await parse(String(shippedRegion(landings([]), "all")));
    const lines = [...doc.querySelectorAll("p")].filter((p) => p.id !== "shipped-top");
    expect(lines.map((p) => [p.className, p.innerHTML])).toEqual([["mt muted", "Nothing has shipped yet."]]);
    expect(doc.querySelectorAll(".card, strong").length).toBe(0);
  });

  test("the region is bounded work (no clock) and reads without script", async () => {
    const { shippedRegion } = await import("../src/web/pages/changelog.ts");
    const many = Array.from({ length: 100 }, (_, i) => landing(i + 1, new Date(Date.UTC(2026, 10, 1) - i * 7_200_000).toISOString()));
    const out = String(shippedRegion(landings(many), "all"));
    // Work, not a stopwatch: about 100 bytes of markup per row beyond its title, a day section per two rows.
    expectWork(out.length, { max: 100 * 700 });
    const doc = await parse(out);
    expect(doc.querySelectorAll("section[data-day] li").length).toBe(100);
  });
});
