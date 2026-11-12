/** /explore.atom: the ranked public apps as Atom; never a private or archived one; advertised on /explore. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo, setArchived } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { checkAtom, parseXml } from "./helpers/atom.ts";

describe("explore atom", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let make: (name: string, visibility: "public" | "private", description?: string) => Promise<Repo>;
  let user: NonNullable<Parameters<typeof createRepo>[1]>;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-explore-atom-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@f.dev", password: "a-good-passphrase", adminIfFirst: true });
    if (!u.ok) throw new Error(u.error);
    user = u.value;
    make = async (name: string, visibility: "public" | "private", description = "") => {
      const r = await createRepo(app, u.value, { name, visibility, description });
      if (!r.ok) throw new Error(String(r.error));
      const a = insertApp(app.db, { repoId: r.value.id, slug: `alice-${name}`, access: visibility });
      if (!a.ok) throw new Error(a.error);
      return r.value;
    };
    await make("shown", "public", "Fish & <chips> \"fresh\"");
    await make("hidden-private", "private");
    const old = await make("hidden-archived", "public");
    const done = await setArchived(app, u.value, old, true, false);
    if (!done.ok) throw new Error("archive");
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("answers Atom with the public app, its link and a plain summary, escaped; no private or archived app", async () => {
    await fetch(`${servers.url}/explore.atom`); // warm: the first request pays for module and statement setup
    const res = await fetch(`${servers.url}/explore.atom`);
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/atom+xml");
    const timing = res.headers.get("server-timing") ?? "";
    // The app's own time, not `lag` (the test process's event loop, busy when suites run together).
    const app50 = Number(/app;dur=([\d.]+)/.exec(timing)?.[1]);
    expect(app50, timing).toBeLessThan(50);
    const { titles } = checkAtom(text, `${servers.url}/explore.atom`);
    expect(titles).toContain("alice/shown");
    expect(titles.join()).not.toContain("hidden");
    expect(text).not.toContain("hidden-private");
    expect(text).not.toContain("hidden-archived");
    expect(text).toContain("Fish &amp; &lt;chips&gt; &quot;fresh&quot;");
    expect(text).toContain(`href="${servers.url}/alice/shown"`);
    const entry = parseXml(text).kids.find((k) => k.name === "entry")!;
    expect(entry.kids.find((k) => k.name === "summary")!.text).toBe('Fish & <chips> "fresh"');
  });

  test("an app's free text with <&\" is escaped end to end; a name with it is refused at creation", async () => {
    const r = await make("tricky", "public", '<&"');
    expect(r.id).toBeTruthy();
    const text = await (await fetch(`${servers.url}/explore.atom`)).text();
    expect(text).toContain("<summary>&lt;&amp;&quot;</summary>");
    expect(text).not.toContain('<summary><&"');
    const entry = parseXml(text).kids.find((k) => k.name === "entry" && k.kids.some((c) => c.name === "summary" && c.text === '<&"'));
    expect(entry).toBeDefined();
    // Titles are owner/name and names are validated, so no title can carry the characters.
    const bad = await createRepo(app, user, { name: '<&"', visibility: "public", description: "" });
    expect(bad.ok).toBe(false);
  });

  test("holds at most 30 entries, newest-made first", async () => {
    for (let i = 0; i < 32; i++) await make(`bulk-${String(i).padStart(2, "0")}`, "public");
    const rows = app.db.query<{ name: string }, []>("SELECT name FROM repo WHERE name LIKE 'bulk-%'").all();
    rows.forEach((r, i) =>
      app.db.run("UPDATE repo SET created_at = ? WHERE name = ?", [`2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`, r.name]),
    );
    const text = await (await fetch(`${servers.url}/explore.atom`)).text();
    const feed = parseXml(text);
    const entries = feed.kids.filter((k) => k.name === "entry");
    expect(entries.length).toBe(30);
    const times = entries.map((e) => Date.parse(e.kids.find((k) => k.name === "updated")!.text));
    expect(times.every((t, i) => i === 0 || times[i - 1]! >= t)).toBe(true);
    expect(new Set(times).size).toBeGreaterThan(1);
  }, 120_000);

  test("/explore advertises the feed", async () => {
    const html = await (await fetch(`${servers.url}/explore`)).text();
    expect(html).toMatch(/<link\s+rel="alternate"\s+type="application\/atom\+xml"[^>]*href="\/explore\.atom"/);
  });
});
